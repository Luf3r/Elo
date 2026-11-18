import { describe, expect, it } from 'vitest';
import { env, evictDurableObject } from 'cloudflare:test';
import type { Env } from '../src/env';
import type { AgentAnalysis, PlanBasis } from '../src/automation/types';
import { catalogFixture } from './fixtures/automation';
import {
  buildAnalysis,
  buildCandidates,
  buildFact,
  buildPlanBasis,
  buildReserveWorkInput,
  buildSnapshotManifest,
  buildSourceRef,
} from './fixtures/builders';
import { durableFailure } from './helpers';

const source = buildSourceRef();

describe('durable resolution reservation', () => {
  const state = () => (env as Env).AUTOMATION_STATE.get((env as Env).AUTOMATION_STATE.newUniqueId());

  async function setup(stub: ReturnType<typeof state>, conversationId = 101, customerId = 'backend-customer') {
    const lease = await stub.reserveWork(
      buildReserveWorkInput({
        requestId: `resolution-${conversationId}`,
        target: { kind: 'conversation', conversationId },
        mode: 'preview',
        actor: { userId: 'operator', clientId: 'client', scopes: ['automation:process'] },
        payloadDigest: 'resolution-input',
      }),
    );
    const basis: PlanBasis = buildPlanBasis(lease, {
      customerId,
      catalogVersion: catalogFixture.version,
    });
    await stub.installSnapshot(
      lease,
      buildSnapshotManifest({
        workId: lease.workId,
        catalogVersion: catalogFixture.version,
        readAt: new Date().toISOString(),
        sources: [source],
      }),
    );
    return basis;
  }

  const newInput = (): AgentAnalysis =>
    buildAnalysis({
      facts: [
        buildFact({ field: 'name', value: 'Synthetic New' }),
        buildFact({ field: 'email', value: 'new@example.test' }),
      ],
      customerSelection: { kind: 'new', entity: 'organization', record: { name: 'Synthetic New' } },
    });

  it('keeps backend IDs stable on retries and eviction; reserves the same identity across conversations', async () => {
    const stub = state();
    const basis = await setup(stub);
    const first = await stub.resolveWork(newInput(), buildCandidates([]), catalogFixture, basis);
    expect(first.customer).toMatchObject({ kind: 'create', customerId: 'backend-customer' });
    expect(first.demands.demands[0]?.kind).toBe('create');

    await evictDurableObject(stub);
    expect(await stub.resolveWork(newInput(), buildCandidates([]), catalogFixture, basis)).toEqual(first);

    const other = await setup(stub, 102, 'other-backend-customer');
    expect((await stub.resolveWork(newInput(), buildCandidates([]), catalogFixture, other)).customer).toMatchObject({
      kind: 'review',
      reviewReasons: ['IDENTITY_RESERVED_FOR_OTHER_CUSTOMER'],
    });
  });

  it('rejects changed retries, stale basis and evidence absent from the server snapshot', async () => {
    const stub = state();
    const basis = await setup(stub);
    await stub.resolveWork(newInput(), buildCandidates([]), catalogFixture, basis);

    expect(
      (
        await durableFailure(stub, (instance) =>
          instance.resolveWork({ ...newInput(), demands: [] }, buildCandidates([]), catalogFixture, basis),
        )
      ).message,
    ).toContain('IDEMPOTENCY_CONFLICT');

    expect(
      (
        await durableFailure(stub, (instance) =>
          instance.resolveWork(newInput(), buildCandidates([]), catalogFixture, { ...basis, snapshotVersion: 2 }),
        )
      ).message,
    ).toContain('STATE_VERSION_CONFLICT');

    const other = await setup(stub, 103, 'third-customer');
    const forged = newInput();
    forged.facts[0]!.sources = [buildSourceRef({ revision: 'forged' })];
    expect(
      (
        await durableFailure(stub, (instance) =>
          instance.resolveWork(forged, buildCandidates([]), catalogFixture, other),
        )
      ).message,
    ).toContain('ANALYSIS_INVALID');
  });

  it('holds pending creation across conversations even for the same backend customer', async () => {
    const stub = state();
    const basis = await setup(stub);
    const first = await stub.resolveWork(newInput(), buildCandidates([]), catalogFixture, basis);
    const other = await setup(stub, 105);
    const next = await stub.resolveWork(newInput(), buildCandidates([]), catalogFixture, other);

    expect(first.customer.kind).toBe('create');
    expect(next.customer).toMatchObject({ kind: 'review', reviewReasons: ['IDENTITY_CREATION_PENDING'] });
  });

  it('reserves a name-only creation without treating a name as proof that customers are identical', async () => {
    const stub = state();
    const basis = await setup(stub);
    const onlyName: AgentAnalysis = {
      ...newInput(),
      facts: [buildFact({ field: 'name', value: 'Synthetic New' })],
    };
    await stub.resolveWork(onlyName, buildCandidates([]), catalogFixture, basis);

    const other = await setup(stub, 106, 'another-customer');
    expect((await stub.resolveWork(onlyName, buildCandidates([]), catalogFixture, other)).customer.kind).toBe('review');
  });
});
