import { env } from 'cloudflare:test';
import { vi } from 'vitest';
import { authorizePlan } from '../../src/domain/authorization';
import type { ExecutionDeps } from '../../src/automation/execution/executor';
import type { MutationOutcome } from '../../src/agendor/crm/types';
import type { Env } from '../../src/env';
import type { MutationCommand } from '../../src/automation/types';
import { catalogFixture, validCommand } from './automation';
import {
  buildActor,
  buildPageInfo,
  buildPlanBasis,
  buildPolicy,
  buildSnapshotManifest,
  buildSyncPlan,
} from './builders';

export async function executionFixture(commands: MutationCommand[] = [validCommand]) {
  const stub = (env as Env).AUTOMATION_STATE.get((env as Env).AUTOMATION_STATE.newUniqueId());
  const actor = buildActor({ scopes: ['automation:process', 'crm:create', 'crm:enrich', 'crm:write'] });
  const lease = await stub.reserveWork({
    requestId: 'work-request',
    target: { kind: 'customer', customerId: 'customer-1' },
    mode: 'apply',
    actor,
    payloadDigest: 'input',
  });
  const basis = buildPlanBasis(lease);
  const plan = buildSyncPlan({ workId: lease.workId, orderedCommands: commands });

  await stub.installSnapshot(
    lease,
    buildSnapshotManifest({
      workId: lease.workId,
      readAt: new Date().toISOString(),
      sources: validCommand.sourceRefs,
    }),
  );
  await stub.savePlan(plan, basis);

  const policy = buildPolicy({ capabilities: ['crm:create', 'crm:enrich', 'crm:write'] });
  const authorization = authorizePlan(actor, plan, policy);
  const write = vi.fn(async (): Promise<MutationOutcome> => ({
    state: 'confirmed',
    ref: { kind: 'organization', id: 99 },
    returnedFields: { name: 'Synthetic Organization' },
  }));
  const verify = vi.fn(async () => [] as string[]);
  const read = vi.fn(async () => ({ id: 99, name: 'Synthetic Organization' }));

  const deps: ExecutionDeps = {
    repository: stub,
    basis,
    requestId: 'apply-request',
    accountKey: 'elotenant',
    catalog: catalogFixture,
    verify,
    mutations: {
      changeStage: write,
      createOrganization: write,
      createPerson: write,
      createDeal: write,
      createTask: write,
      enrichOrganization: write,
      enrichPerson: write,
      enrichDeal: write,
      updateTask: write,
    },
    reads: {
      getOrganization: read,
      getPerson: read,
      getDeal: read,
      getTask: read,
      searchOrganizations: vi.fn(async () => ({
        items: [],
        pageInfo: buildPageInfo(),
      })),
    },
  };

  return { stub, authorization, deps, write, verify, read };
}
