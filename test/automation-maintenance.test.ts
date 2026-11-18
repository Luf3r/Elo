import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { maintainAccount } from '../src/automation/execution/maintenance';
import { AccountRepository, EVIDENCE_RETENTION_MS } from '../src/automation/state/repository';
import { runPlan } from '../src/automation/execution/executor';
import { enqueueOperation, handleAutomationQueue } from '../src/automation/execution/queue';
import { executionFixture } from './fixtures/execution';
import type { Env } from '../src/env';
import { defaultAutomationPolicy } from '../src/automation/service';
import { durableFailure } from './helpers';

it('expires exactly one historical evidence row while preserving a confirmed deduplication key', async () => {
  const f = await executionFixture();
  await runPlan(f.authorization, f.deps);
  const result = await runInDurableObject(f.stub, async (_instance, ctx) => {
    ctx.storage.sql.exec(
      'INSERT INTO events VALUES (?, ?, ?, ?)',
      'old-evidence',
      'hash',
      'historical customer content',
      0,
    );
    const repository = new AccountRepository(ctx.storage);
    const report = await maintainAccount(Date.now(), { repository, queue: { send: async () => undefined } });
    return { report, key: repository.hasCommandKey('company-create') };
  });
  expect(result.report.expiredEvidence).toBe(1);
  expect(result.key).toBe(true);
});

it('persists a recovery delivery before queue send and respects the direct 429 deadline', async () => {
  const f = await executionFixture();
  f.write.mockResolvedValue({ state: 'rejected', code: 'UPSTREAM_RATE_LIMITED', retryAfterSeconds: 40 } as never);
  const status = await runPlan(f.authorization, f.deps);
  await expect(
    enqueueOperation(status.operationId, {
      ...f.deps,
      queue: {
        send: async () => {
          throw Error('queue unavailable');
        },
      },
    }),
  ).rejects.toThrow();
  const result = await runInDurableObject(f.stub, async (_instance, ctx) => {
    const sent: unknown[] = [];
    const repository = new AccountRepository(ctx.storage);
    const early = await maintainAccount(Date.now() + 30_000, {
      repository,
      queue: {
        send: async (p) => {
          sent.push(p);
        },
      },
    });
    const due = await maintainAccount(Date.now() + 41_000, {
      repository,
      queue: {
        send: async (p) => {
          sent.push(p);
        },
      },
    });
    return { early, due, sent };
  });
  expect(result.early.deliveries).toBe(0);
  expect(result.due.deliveries).toBe(1);
  expect(result.sent).toEqual([{ accountKey: 'elotenant', operationId: status.operationId, version: 1 }]);
  expect(f.write).toHaveBeenCalledTimes(1);
});

it('expired reservations require agent attention without consuming a dispatch attempt', async () => {
  const f = await executionFixture();
  const status = await runPlan(f.authorization, { ...f.deps, defer: true });
  await runInDurableObject(f.stub, async (_instance, ctx) => {
    ctx.storage.sql.exec('UPDATE work SET expires_at = 0');
    await maintainAccount(Date.now(), {
      repository: new AccountRepository(ctx.storage),
      queue: { send: async () => undefined },
    });
  });
  expect((await f.stub.getOperation(status.operationId))?.status.state).toBe('authorization_expired');
  expect((await f.stub.getExecutionCommand('company-create'))?.attempts).toBe(0);
  expect(f.write).not.toHaveBeenCalled();
});

it('scrubs retained execution payloads but preserves request and command tombstones', async () => {
  const f = await executionFixture();
  const status = await runPlan(f.authorization, f.deps);
  const result = await runInDurableObject(f.stub, async (_instance, ctx) => {
    const repository = new AccountRepository(ctx.storage);
    await maintainAccount(Date.now() + EVIDENCE_RETENTION_MS + 1, {
      repository,
      queue: { send: async () => undefined },
    });
    return {
      key: repository.hasCommandKey('company-create'),
      rows: ctx.storage.sql.exec('SELECT * FROM execution_operations').toArray(),
      tombstones: ctx.storage.sql.exec('SELECT operation_id FROM execution_tombstones').toArray(),
    };
  });
  expect(result.key).toBe(true);
  expect(result.rows).toEqual([]);
  expect(result.tombstones).toEqual([{ operation_id: status.operationId }]);
});

it('publishes a pending customer projection after queued confirmation, once only', async () => {
  const f = await executionFixture();
  await f.stub.saveContextProjection(
    {
      customerId: 'customer-1',
      version: 1,
      verifiedAt: new Date().toISOString(),
      facts: [],
      contacts: [],
      demands: [],
      receipts: [],
      pendingReasons: [],
    },
    f.deps.basis,
  );
  const status = await runPlan(f.authorization, { ...f.deps, defer: true });
  const message = {
    body: { accountKey: 'elotenant', operationId: status.operationId, version: 1 },
    ack: vi.fn(),
    retry: vi.fn(),
  };
  await handleAutomationQueue({ messages: [message] }, env as Env, () => f.deps);
  const context = await f.stub.getContext('customer-1');
  expect(context.version).toBe(1);
  expect(context.markdown).toContain('company-create');
  await handleAutomationQueue({ messages: [message] }, env as Env, () => f.deps);
  expect((await f.stub.getContext('customer-1')).version).toBe(1);
});

it('records review resolution with CAS and rejects approval of a foreign plan', async () => {
  const f = await executionFixture();
  const owner = f.deps.basis.lease.owner;
  await f.stub.putReview({
    reviewId: 'review-1',
    workId: f.deps.basis.lease.workId,
    customerId: 'customer-1',
    version: 1,
    owner,
    state: 'open',
    reasons: ['AMBIGUOUS'],
  });
  const invalid = await durableFailure(f.stub, (instance) =>
    instance.resolveReview(
      {
        reviewId: 'review-1',
        expectedVersion: 1,
        decision: { kind: 'approvePlan', planId: 'foreign', planVersion: 1 },
      },
      owner,
    ),
  );
  expect(invalid.message).toBe('PLAN_STALE');
  await f.stub.resolveReview(
    { reviewId: 'review-1', expectedVersion: 1, decision: { kind: 'reject', reason: 'Synthetic rejection' } },
    owner,
  );
  const audit = await f.stub.listAudit({ limit: 20 }, owner);
  expect(audit.entries).toEqual(
    expect.arrayContaining([expect.objectContaining({ action: 'review_resolved', targetId: 'review-1', version: 2 })]),
  );
  expect(JSON.stringify(audit)).not.toContain('Synthetic rejection');
  const second = await durableFailure(f.stub, (instance) =>
    instance.resolveReview(
      { reviewId: 'review-1', expectedVersion: 1, decision: { kind: 'reject', reason: 'again' } },
      owner,
    ),
  );
  expect(second.message).toBe('REVIEW_VERSION_CONFLICT');
});

it('pauses queued sends on policy revocation and retains command history', async () => {
  const f = await executionFixture();
  const operation = await runPlan(f.authorization, { ...f.deps, defer: true });
  await f.stub.updatePolicy({ ...defaultAutomationPolicy, version: 2 }, 1, f.deps.basis.lease.owner);
  const report = await runInDurableObject(f.stub, async (_instance, ctx) => {
    const sent: unknown[] = [];
    const report = await maintainAccount(Date.now(), {
      repository: new AccountRepository(ctx.storage),
      queue: {
        send: async (p) => {
          sent.push(p);
        },
      },
    });
    return { report, sent };
  });
  expect(report.sent).toEqual([]);
  expect((await f.stub.getOperation(operation.operationId))?.status).toMatchObject({
    state: 'review',
    pendingReasons: ['POLICY_CHANGED'],
  });
  expect((await f.stub.getExecutionCommand('company-create'))?.attempts).toBe(0);
});

it('rearms its alarm and preserves durable retry state during queue publication failure', async () => {
  const f = await executionFixture();
  const operation = await runPlan(f.authorization, { ...f.deps, defer: true });
  const result = await runInDurableObject(f.stub, async (_instance, ctx) => {
    const report = await maintainAccount(Date.now(), {
      repository: new AccountRepository(ctx.storage),
      queue: {
        send: async () => {
          throw Error('synthetic outage');
        },
      },
    });
    return {
      report,
      rows: ctx.storage.sql.exec('SELECT operation_id, failures, next_attempt_at FROM operation_delivery').toArray(),
      alarm: await ctx.storage.getAlarm(),
    };
  });
  expect(result.report.failedDeliveries).toBe(1);
  expect(result.rows).toEqual([expect.objectContaining({ operation_id: operation.operationId, failures: 1 })]);
  expect(result.alarm).not.toBeNull();
  expect(f.write).not.toHaveBeenCalled();
});

it('uses increasing backoff when 429 omits Retry-After, and keeps a referenced exhausted review', async () => {
  const f = await executionFixture();
  f.write.mockResolvedValue({ state: 'rejected', code: 'UPSTREAM_RATE_LIMITED' } as never);
  await runPlan(f.authorization, f.deps);
  await runInDurableObject(f.stub, (_instance, ctx) => {
    ctx.storage.sql.exec('UPDATE execution_commands SET next_attempt_at = 0');
  });
  await runPlan(f.authorization, f.deps);
  const second = await f.stub.getExecutionCommand('company-create');
  expect(second!.nextAttemptAt - Date.now()).toBeGreaterThan(19_000);
  for (let i = 0; i < 5; i++) {
    await runInDurableObject(f.stub, (_instance, ctx) => {
      ctx.storage.sql.exec('UPDATE execution_commands SET next_attempt_at = 0');
    });
    await runPlan(f.authorization, f.deps);
  }
  expect(f.write).toHaveBeenCalledTimes(5);
  expect((await f.stub.getExecutionCommand('company-create'))?.state).toBe('review');
  expect((await f.stub.listReviews({ limit: 20 }, f.deps.basis.lease.owner)).reviews).toEqual(
    expect.arrayContaining([expect.objectContaining({ reasons: ['ATTEMPTS_EXHAUSTED'] })]),
  );
});

it('preserves already published customer facts when a later conversation contributes only a new demand', async () => {
  const f = await executionFixture();
  const basis = f.deps.basis;
  const original = {
    customerId: 'customer-1',
    version: 1,
    verifiedAt: new Date().toISOString(),
    facts: [
      {
        entity: 'organization' as const,
        field: 'name',
        value: 'Persistent Customer',
        certainty: 'confirmed' as const,
        sources: f.authorization.plan.sourceRefs,
      },
    ],
    contacts: [],
    demands: [],
    receipts: [],
    pendingReasons: [],
  };
  await f.stub.saveContextProjection(original, basis);
  await f.stub.refreshCustomerContext('customer-1', 0);
  const lease = await f.stub.reserveWork({
    requestId: 'another-conversation',
    target: { kind: 'conversation', conversationId: 102 },
    mode: 'preview',
    actor: f.authorization.actor,
    payloadDigest: 'another-input',
  });
  const next = { ...basis, lease, contextVersion: 1 };
  await f.stub.installSnapshot(lease, {
    workId: lease.workId,
    snapshotVersion: 1,
    contextVersion: 1,
    catalogVersion: 'catalog-1',
    readAt: new Date().toISOString(),
    sources: [],
    messages: [],
    records: [],
    coverage: { complete: true, pagesRead: 1, missingReasons: [] },
  });
  await f.stub.saveContextProjection({ ...original, version: 2, facts: [] }, next);
  const context = await f.stub.refreshCustomerContext('customer-1', 1);
  expect(context.markdown).toContain('Persistent Customer');
});
