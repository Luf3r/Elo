import { env } from 'cloudflare:test';
import { vi } from 'vitest';
import { authorizePlan } from '../../src/automation/authorization';
import type { ExecutionDeps } from '../../src/automation/executor';
import type { MutationOutcome } from '../../src/agendor/crm/types';
import type { Env } from '../../src/env';
import type { MutationCommand, SyncPlan } from '../../src/automation/types';
import { catalogFixture, validCommand, validPlan } from './automation';
export async function executionFixture(commands: MutationCommand[] = [validCommand]) {
  const stub = (env as Env).AUTOMATION_STATE.get((env as Env).AUTOMATION_STATE.newUniqueId());
  const actor = { userId: 'operator-1', clientId: 'client-1', scopes: ['automation:process', 'crm:create', 'crm:enrich', 'crm:write'], expiresAt: Date.now() + 600_000 };
  const lease = await stub.reserveWork({ requestId: 'work-request', target: { kind: 'customer', customerId: 'customer-1' }, mode: 'apply', actor, payloadDigest: 'input' });
  const basis = { lease, customerId: 'customer-1', snapshotVersion: 1, contextVersion: 0, catalogVersion: 'catalog-1' };
  const plan: SyncPlan = { ...validPlan, workId: lease.workId, orderedCommands: commands };
  await stub.installSnapshot(lease, { workId: lease.workId, snapshotVersion: 1, contextVersion: 0, catalogVersion: 'catalog-1', readAt: new Date().toISOString(), sources: validCommand.sourceRefs, messages: [], records: [], coverage: { complete: true, pagesRead: 1, missingReasons: [] } });
  await stub.savePlan(plan, basis);
  const policy = { version: 1, mode: 'apply' as const, allowedInboxIds: [], capabilities: ['crm:create', 'crm:enrich', 'crm:write'] as const, funnelMapping: {}, stageMapping: [], customFieldMapping: [], nativeCreatorDisabled: true, limits: { maxConversations: 10, maxCommands: 10, maxRequests: 20 } };
  const authorization = authorizePlan(actor, plan, { ...policy, capabilities: [...policy.capabilities] });
  const write = vi.fn(async (): Promise<MutationOutcome> => ({ state: 'confirmed', ref: { kind: 'organization', id: 99 }, returnedFields: { name: 'Synthetic Organization' } }));
  const verify = vi.fn(async () => [] as string[]);
  const read = vi.fn(async () => ({ id: 99, name: 'Synthetic Organization' }));
  const deps: ExecutionDeps = { repository: stub, basis, requestId: 'apply-request', accountKey: 'elotenant', catalog: catalogFixture, verify,
    mutations: { changeStage: write, createOrganization: write, createPerson: write, createDeal: write, createTask: write, enrichOrganization: write, enrichPerson: write, enrichDeal: write, updateTask: write },
    reads: { getOrganization: read, getPerson: read, getDeal: read, getTask: read, searchOrganizations: vi.fn(async () => ({ items: [], pageInfo: { page: 1, perPage: 100, hasNext: false, nextPage: null } })) } };
  return { stub, authorization, deps, write, verify, read };
}
