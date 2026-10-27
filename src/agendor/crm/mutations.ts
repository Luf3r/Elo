import type { z } from 'zod';
import type { Env } from '../../env';
import { isConfiguredSecret } from '../../auth';
import { throwIfCancelled } from '../../cancellation';
import { SafeError, safeError } from '../../errors';
import { fetchJson } from '../../http';
import { createBudgetGate, type BudgetGate } from '../../automation/state/budget';
import type { CatalogSnapshot, CrmMutationClient, CrmMutationRef, MutationOutcome } from './types';
import { createMutationSchemas, crmIdSchema } from './mutation-schemas';
import { parseInput } from './schemas';

export interface CrmMutationDependencies {
  env: Pick<Env, 'AGENDOR_CRM_TOKEN'> & Partial<Pick<Env, 'AUTOMATION_STATE'>>;
  catalog: CatalogSnapshot;
  budgetGate?: BudgetGate;
  signal?: AbortSignal;
  request?: (request: Request) => Promise<Response>;
  timeoutMs?: number;
}
const paths = { organization: 'organizations', person: 'people', deal: 'deals', task: 'tasks' } as const;
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
/** Project only requested keys; unrelated upstream permissions, URLs, headers
 * and nested contact fields never become returned evidence. */
function project(requested: Record<string, unknown>, returned: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, sample] of Object.entries(requested)) {
    if (key === 'checkRequiredFields' || !Object.hasOwn(returned, key)) continue;
    const value = returned[key];
    const sampleObject = object(sample);
    if (sampleObject) {
      const valueObject = object(value);
      if (valueObject) result[key] = project(sampleObject, valueObject);
    } else if (Array.isArray(sample)) {
      if (Array.isArray(value) && value.length <= 100 && value.every(item => typeof item === 'string' || typeof item === 'number' && Number.isFinite(item))) result[key] = value;
    } else if (value === null || typeof value === typeof sample && (typeof value !== 'number' || Number.isFinite(value))) result[key] = value;
  }
  return result;
}
function writePayload(record: Record<string, unknown>, catalog: CatalogSnapshot): Record<string, unknown> {
  if (!Array.isArray(record.customFields)) return record;
  return { ...record, customFields: Object.fromEntries(record.customFields.map((field: { id: string | number; value: unknown }) => {
    const entry = catalog.customFields.find(candidate => String(candidate.id) === String(field.id) || candidate.identifier === field.id || candidate.name === field.id);
    const key = typeof entry?.identifier === 'string' && entry.identifier.trim() ? entry.identifier.trim() : typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : String(field.id);
    return [key, field.value];
  })) };
}

/** Internal single-dispatch adapter. The executor reserves a durable commandKey
 * and resolves dependency IDs first. Agendor documents no idempotency HTTP
 * header; uncertainty never authorizes an automatic retry. */
export function createCrmMutationClient(deps: CrmMutationDependencies): CrmMutationClient {
  const schemas = createMutationSchemas(deps.catalog);
  const budget = deps.budgetGate ?? createBudgetGate(deps.env, 'crm');
  async function send(kind: CrmMutationRef['kind'], method: 'POST' | 'PUT', route: string, record: Record<string, unknown>, expectedId?: number): Promise<MutationOutcome> {
    // Existing collections have no verified replacement/merge contract. Create
    // may initialize custom fields/assignees; product pricing remains unverified.
    if (record.products_entities !== undefined || method === 'PUT' && (record.customFields !== undefined || record.assigned_users !== undefined)) {
      return { state: 'rejected', code: 'COLLECTION_WRITE_UNVERIFIED' };
    }
    throwIfCancelled(deps.signal);
    if (!isConfiguredSecret(deps.env.AGENDOR_CRM_TOKEN)) throw new SafeError('UPSTREAM_UNAVAILABLE', 'CRM service is not configured.', false, 503);
    const payload = writePayload(record, deps.catalog);
    const request = new Request(`https://api.agendor.com.br/v3${route}`, {
      method, signal: deps.signal, redirect: 'manual',
      headers: { Authorization: `Token ${deps.env.AGENDOR_CRM_TOKEN}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await budget();
    throwIfCancelled(deps.signal);
    let dispatched = false;
    let response: unknown;
    try {
      response = await fetchJson<unknown>(request, { timeoutMs: deps.timeoutMs, request: request => {
        dispatched = true;
        return (deps.request ?? fetch)(request);
      } });
    } catch (error) {
      if (!dispatched) throw error;
      if (deps.signal?.aborted) return { state: 'uncertain', reason: 'UPSTREAM_CANCELLED' };
      const safe = safeError(error);
      if (safe.status !== undefined && safe.status >= 400 && safe.status < 500 && safe.status !== 408) {
        return { state: 'rejected', code: safe.code, ...(safe.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: safe.retryAfterSeconds }) };
      }
      return { state: 'uncertain', reason: safe.code };
    }
    const envelope = object(response);
    const returned = object(kind === 'task' && method === 'PUT' ? envelope?.task_entity : envelope?.data);
    const id = crmIdSchema.safeParse(returned?.id);
    if (!returned || !id.success || expectedId !== undefined && id.data !== expectedId) return { state: 'uncertain', reason: 'UPSTREAM_INVALID_RESPONSE' };
    return { state: 'confirmed', ref: { kind, id: id.data }, returnedFields: project(payload, returned) };
  }
  async function enrich(kind: CrmMutationRef['kind'], id: number, patch: unknown, schema: z.ZodType) {
    const validId = parseInput(crmIdSchema, id);
    return send(kind, 'PUT', `/${paths[kind]}/${validId}`, parseInput(schema, patch) as Record<string, unknown>, validId);
  }
  return {
    async changeStage(id, patch) {
      const validId = parseInput(crmIdSchema, id);
      return send('deal', 'PUT', `/deals/${validId}/stage`, { ...parseInput(schemas.changeStage, patch), checkRequiredFields: true }, validId);
    },
    async createOrganization(record) { return send('organization', 'POST', '/organizations', parseInput(schemas.createOrganization, record)); },
    async createPerson(record) { return send('person', 'POST', '/people', parseInput(schemas.createPerson, record)); },
    async createDeal(parent, record) {
      const valid = parseInput(schemas.createDeal, { parent, record });
      return send('deal', 'POST', `/${paths[valid.parent.kind]}/${valid.parent.id}/deals`, { ...valid.record, checkRequiredFields: true });
    },
    async createTask(parent, record) {
      const valid = parseInput(schemas.createTask, { parent, record });
      return send('task', 'POST', `/${paths[valid.parent.kind]}/${valid.parent.id}/tasks`, valid.record);
    },
    enrichOrganization: (id, patch) => enrich('organization', id, patch, schemas.enrichOrganization),
    enrichPerson: (id, patch) => enrich('person', id, patch, schemas.enrichPerson),
    enrichDeal: (id, patch) => enrich('deal', id, patch, schemas.enrichDeal),
    updateTask: (id, patch) => enrich('task', id, patch, schemas.updateTask),
  };
}
