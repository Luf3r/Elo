import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { enqueueOperation, handleAutomationQueue } from '../src/automation/execution/queue';
import { runPlan } from '../src/automation/execution/executor';
import { executionFixture } from './fixtures/execution';

it('queues reference-only payload after durable reservation and duplicate delivery never resends', async () => {
  const f = await executionFixture();
  const send = vi.fn(async (_body: unknown) => undefined);
  const operation = await runPlan(f.authorization, { ...f.deps, defer: true });
  expect(operation.state).toBe('queued');
  expect(f.write).not.toHaveBeenCalled();
  await enqueueOperation(operation.operationId, { ...f.deps, queue: { send } });
  expect(send).toHaveBeenCalledWith({ accountKey: 'elotenant', operationId: operation.operationId, version: 1 });
  const ack = vi.fn();
  const retry = vi.fn();
  const batch = { messages: [{ body: send.mock.calls[0]![0], attempts: 1, ack, retry }] };
  await handleAutomationQueue(batch, env, () => f.deps);
  await handleAutomationQueue(batch, env, () => f.deps);
  expect(f.write).toHaveBeenCalledTimes(1);
  expect(ack).toHaveBeenCalledTimes(2);
  expect(retry).not.toHaveBeenCalled();
});

it('rejects unreserved enqueue and malformed or foreign account messages', async () => {
  const f = await executionFixture();
  const send = vi.fn(async () => undefined);
  await expect(enqueueOperation('missing', { ...f.deps, queue: { send } })).rejects.toThrow('OPERATION');
  expect(send).not.toHaveBeenCalled();
  for (const body of [
    { accountKey: 'other', operationId: 'x', version: 1 },
    { accountKey: 'elotenant', operationId: 'x', version: 1, token: 'never-store-this' },
  ]) {
    const ack = vi.fn();
    const factory = vi.fn(() => f.deps);
    await handleAutomationQueue({ messages: [{ body, attempts: 1, ack, retry: vi.fn() }] }, env, factory);
    expect(ack).toHaveBeenCalledOnce();
    expect(factory).not.toHaveBeenCalled();
  }
});

it('retains reserved commands on expiry and caps known-safe transient attempts at five', async () => {
  const f = await executionFixture();
  f.write.mockResolvedValue({ state: 'rejected', code: 'UPSTREAM_RATE_LIMITED', retryAfterSeconds: 0 } as never);
  for (let i = 0; i < 8; i++) {
    await runPlan(f.authorization, f.deps);
    await runInDurableObject(f.stub, (_instance, ctx) =>
      ctx.storage.sql.exec('UPDATE execution_commands SET next_attempt_at = 0').toArray(),
    );
  }
  expect(f.write).toHaveBeenCalledTimes(5);
  expect((await f.stub.getOperationByRequest('apply-request'))?.status).toMatchObject({ state: 'review' });
});
