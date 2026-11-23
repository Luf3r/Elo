import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import {
  enqueueOperation,
  handleAutomationQueue,
  type AutomationQueuePayload,
} from '../src/automation/execution/queue';
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
  await handleAutomationQueue(
    batch,
    env,
    () => f.deps,
    vi.fn(async () => undefined),
  );
  await handleAutomationQueue(
    batch,
    env,
    () => f.deps,
    vi.fn(async () => undefined),
  );
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
    await handleAutomationQueue(
      { messages: [{ body, attempts: 1, ack, retry: vi.fn() }] },
      env,
      factory,
      vi.fn(async () => undefined),
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(factory).not.toHaveBeenCalled();
  }
});

it('acknowledges malformed queue messages and logs without the body', async () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const ack = vi.fn();
  const retry = vi.fn();
  const requeue = vi.fn(async (_payload: AutomationQueuePayload, _delaySeconds: number) => undefined);

  await handleAutomationQueue(
    { messages: [{ body: { token: 'must-not-log' }, attempts: 1, ack, retry }] },
    env,
    () => {
      throw new Error('Factory must not run');
    },
    requeue,
  );

  expect(ack).toHaveBeenCalledOnce();
  expect(retry).not.toHaveBeenCalled();
  expect(requeue).not.toHaveBeenCalled();
  expect(warnSpy).toHaveBeenCalledWith({ event: 'queue_message_malformed' });
  expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('must-not-log');
});

it('requeues waiting operations and acknowledges the original message', async () => {
  const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const f = await executionFixture();
  const operation = await runPlan(f.authorization, { ...f.deps, defer: true });
  const payload = { accountKey: 'elotenant', operationId: operation.operationId, version: 1 };
  await runInDurableObject(f.stub, (_instance, ctx) =>
    ctx.storage.sql.exec('UPDATE execution_commands SET next_attempt_at = ?', Date.now() + 60_000).toArray(),
  );
  const ack = vi.fn();
  const retry = vi.fn();
  const requeue = vi.fn(async (_payload: AutomationQueuePayload, _delaySeconds: number) => undefined);

  await handleAutomationQueue({ messages: [{ body: payload, attempts: 1, ack, retry }] }, env, () => f.deps, requeue);

  expect(requeue).toHaveBeenCalledOnce();
  expect(requeue.mock.calls[0]?.[0]).toEqual(payload);
  expect(requeue.mock.calls[0]?.[1]).toBeGreaterThanOrEqual(1);
  expect(requeue.mock.calls[0]?.[1]).toBeLessThanOrEqual(43_200);
  expect(ack).toHaveBeenCalledOnce();
  expect(retry).not.toHaveBeenCalled();
  expect(infoSpy).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'queue_message_rescheduled', state: 'queued' }),
  );
});

it('retries the original message when requeueing a waiting operation fails', async () => {
  const f = await executionFixture();
  const operation = await runPlan(f.authorization, { ...f.deps, defer: true });
  await runInDurableObject(f.stub, (_instance, ctx) =>
    ctx.storage.sql.exec('UPDATE execution_commands SET next_attempt_at = ?', Date.now() + 60_000).toArray(),
  );
  const ack = vi.fn();
  const retry = vi.fn();
  const requeue = vi.fn(async () => {
    throw new Error('Queue send failed');
  });

  await handleAutomationQueue(
    {
      messages: [
        { body: { accountKey: 'elotenant', operationId: operation.operationId, version: 1 }, attempts: 1, ack, retry },
      ],
    },
    env,
    () => f.deps,
    requeue,
  );

  expect(requeue).toHaveBeenCalledOnce();
  expect(retry).toHaveBeenCalledWith({ delaySeconds: 10 });
  expect(ack).not.toHaveBeenCalled();
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
