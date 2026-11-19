import { z } from 'zod';
import type { Env } from '../env';
import { requireCapabilities, type AuthContext } from '../auth';
import { TENANT_ACCOUNT_KEY } from '../app/config/tenant';
import { SafeError } from '../shared/errors';
import { throwIfCancelled } from '../shared/cancellation';
import { createAgendorCrmClient, createCrmMutationClient } from './clients';
import { createCatalogSnapshot } from '../agendor/crm/catalog';
import * as mutation from '../agendor/crm/mutation-schemas';
import {
  parseInput,
  updateOrganizationInput,
  updatePersonInput,
  updateDealInput,
  updateDealStageInput,
} from '../agendor/crm/schemas';
import { accountState } from './state/budget';
import { automationActor, persistWorkflow, readWorkflow } from './service';
import { payloadDigest, canonical } from './operations';
import { runPlan } from './execution/executor';
import { enqueueOperation } from './execution/queue';
import { mutationCommandSchema, authorizedPlanSchema, syncPlanSchema } from './schemas';
import { readRef } from './execution/reconciliation';
import type { WorkflowState } from './service-state';
import type { CatalogSnapshot, MutationCommand, OperationStatus } from './types';

export type DirectToolName =
  | 'crm_create_organization'
  | 'crm_create_person'
  | 'crm_create_deal'
  | 'crm_create_task'
  | 'crm_enrich_organization'
  | 'crm_enrich_person'
  | 'crm_enrich_deal'
  | 'crm_update_task'
  | 'crm_update_organization'
  | 'crm_update_person'
  | 'crm_update_deal'
  | 'crm_update_deal_stage';
const requestId = z.string().trim().min(1).max(200);
const patches = {
  crm_enrich_organization: mutation.enrichOrganizationSchema,
  crm_enrich_person: mutation.enrichPersonSchema,
  crm_enrich_deal: mutation.enrichDealSchema,
  crm_update_task: mutation.updateTaskSchema,
  crm_update_organization: updateOrganizationInput,
  crm_update_person: updatePersonInput,
  crm_update_deal: updateDealInput,
  crm_update_deal_stage: updateDealStageInput,
} as const;
const creation = {
  crm_create_organization: z.strictObject({ requestId, record: mutation.createOrganizationSchema }),
  crm_create_person: z.strictObject({ requestId, record: mutation.createPersonSchema }),
  crm_create_deal: mutation.createDealSchema.extend({ requestId }),
  crm_create_task: mutation.createTaskSchema.extend({ requestId }),
} as const;
const kind = {
  crm_create_organization: 'create_organization',
  crm_create_person: 'create_person',
  crm_create_deal: 'create_deal',
  crm_create_task: 'create_task',
  crm_enrich_organization: 'enrich_organization',
  crm_enrich_person: 'enrich_person',
  crm_enrich_deal: 'enrich_deal',
  crm_update_task: 'update_task',
  crm_update_organization: 'legacy_update_organization',
  crm_update_person: 'legacy_update_person',
  crm_update_deal: 'legacy_update_deal',
  crm_update_deal_stage: 'legacy_update_stage',
} as const;

/** Explicit direct calls become one server-authorized command. They retain the
 * requested OAuth capability; no automation or expanded CRM grant is invented. */
export async function executeDirectCommand(
  env: Env,
  auth: AuthContext,
  name: DirectToolName,
  raw: unknown,
  signal?: AbortSignal,
): Promise<OperationStatus> {
  const legacy = name.startsWith('crm_update_') && name !== 'crm_update_task';
  const capability = legacy ? 'crm:write' : name.startsWith('crm_create_') ? 'crm:create' : 'crm:enrich';
  requireCapabilities(auth, [capability]);
  const caller = automationActor(auth);
  throwIfCancelled(signal);
  const schema =
    name in creation
      ? creation[name as keyof typeof creation]
      : z.strictObject({ requestId, id: mutation.crmIdSchema, patch: patches[name as keyof typeof patches] });
  const input = parseInput(schema, raw) as {
    requestId: string;
    record?: Record<string, unknown>;
    parent?: { kind: 'organization' | 'person' | 'deal'; id: number };
    id?: number;
    patch?: Record<string, unknown>;
  };
  const digest = await payloadDigest({ name, input });
  const repo = accountState(env);
  const existing = await repo.getOperationByRequest(input.requestId);
  if (existing) {
    const state = await readWorkflow(repo, existing.input.basis.lease.workId);
    if (
      state?.direct?.digest !== digest ||
      existing.input.authorization.actor.userId !== caller.userId ||
      existing.input.authorization.actor.clientId !== caller.clientId
    )
      throw new SafeError('CONFLICT', 'requestId already belongs to another payload or actor.', false, 409);
    if (existing.status.state === 'queued')
      await enqueueOperation(existing.operationId, {
        repository: repo,
        accountKey: TENANT_ACCOUNT_KEY,
        queue: env.AUTOMATION_QUEUE,
      });
    return existing.status;
  }
  const record = input.record ?? input.patch ?? {};
  const entity = name.endsWith('_organization')
    ? 'organization'
    : name.endsWith('_person')
      ? 'person'
      : name.endsWith('_task')
        ? 'task'
        : 'deal';
  const customerId = input.id
    ? `crm:${entity}:${input.id}`
    : input.parent
      ? `crm:${input.parent.kind}:${input.parent.id}`
      : `direct:${caller.clientId}:${input.requestId}`;
  const lease = await repo.reserveWork({
    requestId: 'direct:' + input.requestId,
    target: { kind: 'customer', customerId },
    mode: 'apply',
    actor: caller,
    payloadDigest: digest,
  });
  const crm = createAgendorCrmClient(env, { signal });
  let catalog: CatalogSnapshot = createCatalogSnapshot({ accountId: TENANT_ACCOUNT_KEY, pages: [] });
  // Basic direct/legacy patches need no catalog traversal. Dynamic field and
  // owner/assignee/product references require their exact catalog sections.
  const pages = [];
  if (record.customFields !== undefined && entity !== 'task')
    pages.push(
      await crm.getConfiguration({
        section: 'customFields',
        entityType: entity === 'organization' ? 'organizations' : entity === 'person' ? 'people' : 'deals',
      }),
    );
  if (record.ownerUser !== undefined || record.assigned_users !== undefined)
    pages.push(await crm.getConfiguration({ section: 'users' }));
  if (record.products_entities !== undefined) pages.push(await crm.getConfiguration({ section: 'products' }));
  if (pages.length) catalog = createCatalogSnapshot({ accountId: TENANT_ACCOUNT_KEY, pages });
  const source = { kind: 'operator' as const, id: caller.userId, revision: digest };
  const command: MutationCommand = mutationCommandSchema.parse({
    kind: kind[name],
    commandKey:
      'direct:' +
      (await payloadDigest({ userId: caller.userId, clientId: caller.clientId, requestId: input.requestId })),
    dependencies: [],
    before: [],
    sourceRefs: [source],
    requiredCapabilities: [capability],
    ...(input.record
      ? { payload: input.record, ...(input.parent ? { target: input.parent } : {}) }
      : { target: { kind: entity, id: input.id }, patch: input.patch }),
  });
  const basis = { lease, customerId, snapshotVersion: 1, contextVersion: 0, catalogVersion: catalog.version };
  const state: WorkflowState = {
    revision: 0,
    lease,
    customerId,
    continuation: crypto.randomUUID(),
    step: 0,
    conversationIds: [],
    conversations: [],
    pages: [],
    candidates: { candidates: [], coverage: { complete: true, pagesRead: 0, missingReasons: [] } },
    catalog,
    basis,
    direct: { digest, capability, command },
  };
  const previous = await readWorkflow(repo, lease.workId);
  if (previous) {
    if (previous.direct?.digest !== digest) throw new SafeError('CONFLICT', 'Conflicting request payload.', false, 409);
    state.revision = previous.revision;
  }
  await persistWorkflow(repo, state);
  await repo.installSnapshot(lease, {
    workId: lease.workId,
    snapshotVersion: 1,
    contextVersion: 0,
    catalogVersion: catalog.version,
    readAt: new Date().toISOString(),
    sources: [source],
    messages: [],
    records: [],
    coverage: { complete: true, pagesRead: 0, missingReasons: [] },
  });
  const plan = syncPlanSchema.parse({
    planId: 'direct-plan:' + lease.workId,
    version: 1,
    policyVersion: (await repo.getExecutionPolicy())?.version ?? 1,
    workId: lease.workId,
    analysisRevision: 1,
    orderedCommands: [command],
    before: [],
    after: [],
    sourceRefs: [source],
    reviewIds: [],
    state: 'ready',
  });
  await repo.savePlan(plan, basis);
  const authorization = authorizedPlanSchema.parse({
    plan,
    actor: caller,
    commandCapabilities: [{ commandKey: command.commandKey, capabilities: [capability] }],
    validUntil: new Date(Math.min(caller.expiresAt, Date.now() + 300_000)).toISOString(),
  });
  const result = await runPlan(authorization, {
    repository: repo,
    basis,
    requestId: input.requestId,
    accountKey: TENANT_ACCOUNT_KEY,
    catalog,
    reads: crm,
    legacy: crm,
    mutations: createCrmMutationClient({ env, catalog, signal }),
    signal,
    async verify(current) {
      const stored = await readWorkflow(repo, lease.workId);
      if (stored?.direct?.digest !== digest || canonical(stored.direct.command) !== canonical(current))
        return ['DIRECT_AUTHORIZATION_CHANGED'];
      if (input.parent) {
        const parent = await readRef(input.parent, crm);
        if (!parent || typeof parent !== 'object' || !('id' in parent) || parent.id !== input.parent.id)
          return ['PARENT_UNVERIFIED'];
      }
      return [];
    },
  });
  if (result.state === 'applied') await repo.completeDirectOperation(result.operationId);
  if (result.state === 'queued')
    await enqueueOperation(result.operationId, {
      repository: repo,
      accountKey: TENANT_ACCOUNT_KEY,
      queue: env.AUTOMATION_QUEUE,
    });
  return result;
}
