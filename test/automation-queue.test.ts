import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import {
  QUEUE_MAX_RETRIES,
  enqueueOperation,
  handleAutomationQueue,
  type AutomationQueuePayload,
} from '../src/automation/execution/queue';
import { runPlan } from '../src/automation/execution/executor';
import { maintainAccount } from '../src/automation/execution/maintenance';
import { AccountRepository } from '../src/automation/state/repository';
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

it('acknowledges malformed queue messages and logs without the body', async () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const ack = vi.fn();
  const retry = vi.fn();

  await handleAutomationQueue({ messages: [{ body: { token: 'must-not-log' }, attempts: 1, ack, retry }] }, env, () => {
    throw new Error('Factory must not run');
  });

  expect(ack).toHaveBeenCalledOnce();
  expect(retry).not.toHaveBeenCalled();
  expect(warnSpy).toHaveBeenCalledWith({ event: 'queue_message_malformed' });
  expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('must-not-log');
});

async function waitingOperation() {
  const f = await executionFixture();
  const operation = await runPlan(f.authorization, { ...f.deps, defer: true });
  await runInDurableObject(f.stub, (_instance, ctx) =>
    ctx.storage.sql.exec('UPDATE execution_commands SET next_attempt_at = ?', Date.now() + 60_000).toArray(),
  );
  const payload: AutomationQueuePayload = { accountKey: 'elotenant', operationId: operation.operationId, version: 1 };
  return { f, payload };
}

it('reschedules waiting operations with a delayed retry before the delivery limit', async () => {
  const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { f, payload } = await waitingOperation();
  const ack = vi.fn();
  const retry = vi.fn();

  await handleAutomationQueue({ messages: [{ body: payload, attempts: 4, ack, retry }] }, env, () => f.deps);

  expect(f.write).not.toHaveBeenCalled();
  expect(ack).not.toHaveBeenCalled();
  expect(retry).toHaveBeenCalledOnce();
  const delaySeconds = (retry.mock.calls[0]?.[0] as { delaySeconds: number }).delaySeconds;
  expect(delaySeconds).toBeGreaterThanOrEqual(55);
  expect(delaySeconds).toBeLessThanOrEqual(60);
  expect(infoSpy).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'queue_message_rescheduled', attempts: 4, state: 'queued' }),
  );
  expect(errorSpy).not.toHaveBeenCalled();
});

it('parks a waiting operation on the final delivery instead of dead-lettering it', async () => {
  const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { f, payload } = await waitingOperation();
  const ack = vi.fn();
  const retry = vi.fn();

  await handleAutomationQueue(
    { messages: [{ body: payload, attempts: QUEUE_MAX_RETRIES + 1, ack, retry }] },
    env,
    () => f.deps,
  );

  expect(retry).not.toHaveBeenCalled();
  expect(ack).toHaveBeenCalledOnce();
  expect(infoSpy).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'queue_message_parked', attempts: QUEUE_MAX_RETRIES + 1, state: 'queued' }),
  );
  expect(errorSpy).not.toHaveBeenCalled();
  // The durable state still offers the operation to the watchdog, which
  // starts a fresh, bounded delivery chain.
  const sent = await runInDurableObject(f.stub, async (_instance, ctx) => {
    const bodies: unknown[] = [];
    await maintainAccount(Date.now() + 120_000, {
      repository: new AccountRepository(ctx.storage),
      queue: { send: async (body) => void bodies.push(body) },
    });
    return bodies;
  });
  expect(sent).toEqual([payload]);
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
