import { afterEach, expect, it, vi } from 'vitest';
import { createAutomationService } from '../src/automation/service';
import { budgetMock, durableFailure, testEnv } from './helpers';
import { runInDurableObject } from 'cloudflare:test';
import { accountState } from '../src/automation/state/budget';
import * as chat from '../src/agendor/chat/client';
import { SafeError } from '../src/errors';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('reports and bounds repeated budget deferrals without durable progress', async () => {
  const env = testEnv({ AGENDOR_CHAT_TOKEN: 'synthetic', AGENDOR_CHAT_ACCOUNT_ID: '123' });
  const budget = budgetMock(env);
  budget.mockImplementation(async () => ({ allowed: false, retryAt: Date.now() + 10_000 }));
  const actor = { userId: 'synthetic', clientId: 'client', scopes: ['automation:process', 'automation:read', 'chat:read', 'crm:read'], expiresAt: Date.now() + 600_000 };
  const service = createAutomationService(env, actor);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const input = { requestId: 'bounded-deferred', target: { kind: 'conversation' as const, conversationId: 101 }, mode: 'preview' as const, limits: { maxMessagePages: 1, maxAttachmentPages: 0 } };
  let result = await service.prepare(input);
  expect(result).toMatchObject({ state: 'deferred', reason: 'UPSTREAM_RATE_LIMITED', progress: expect.objectContaining({ stage: expect.any(String) }) });
  if (result.state !== 'deferred') throw Error('Expected deferred');
  const early = await service.prepare({ requestId: input.requestId, workId: result.workId, leaseToken: result.leaseToken!, continuation: result.continuation! });
  expect(early).toEqual(result); expect(budget).toHaveBeenCalledTimes(1);
  for (let attempt = 1; attempt < 5; attempt++) {
    if (result.state !== 'deferred') throw Error('Expected deferred');
    const deferredWorkId = result.workId;
    await runInDurableObject(env.AUTOMATION_STATE.get(accountState(env).id), (_instance, ctx) => ctx.storage.sql.exec("UPDATE events SET data = json_set(data, '$.preparationDeferral.nextRetryAt', ?) WHERE event_id = ?", '2000-01-01T00:00:00.000Z', 'workflow:' + deferredWorkId));
    result = await service.prepare({ requestId: input.requestId, workId: result.workId, leaseToken: result.leaseToken!, continuation: result.continuation! });
  }
  expect(result).toMatchObject({ state: 'blocked', reason: 'PREPARATION_NO_PROGRESS', progress: expect.any(Object) });
  const audit = await service.getAudit({ limit: 100 });
  expect(audit.entries.map(e => e.action)).toEqual(expect.arrayContaining(['lease_acquired', 'work_created', 'preparation_deferred_UPSTREAM_RATE_LIMITED', 'preparation_blocked']));
  expect(JSON.stringify(audit)).not.toContain('leaseToken');
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps pending work and audit isolated to its owner across independent clients', async () => {
  const env = testEnv({ AGENDOR_CHAT_TOKEN: 'synthetic', AGENDOR_CHAT_ACCOUNT_ID: '123' });
  budgetMock(env).mockResolvedValue({ allowed: false, retryAt: Date.now() + 10_000 });
  const actor = { userId: 'synthetic', clientId: 'client-one', scopes: ['automation:process', 'automation:read', 'automation:manage', 'chat:read', 'crm:read'], expiresAt: Date.now() + 600_000 };
  const own = createAutomationService(env, actor);
  const other = createAutomationService(env, { ...actor, clientId: 'client-two' });
  await own.updatePolicy({ expectedVersion: 1, patch: { mode: 'preview' } });
  const result = await own.prepare({ requestId: 'owner-work', target: { kind: 'conversation', conversationId: 101 }, mode: 'preview' });
  expect(result.state).toBe('deferred');
  expect(await own.getStatus()).toMatchObject({ awaitingAgent: 0, preparing: 1, incompleteCoverage: 0 });
  expect(await other.getStatus()).toMatchObject({ awaitingAgent: 0, preparing: 0, incompleteCoverage: 0 });
  const first = await own.getAudit({ limit: 100 });
  const second = await other.getAudit({ limit: 100 });
  expect(first.entries.some(e => e.action === 'work_created')).toBe(true);
  expect(second.entries).toEqual([]);
  if (result.state !== 'deferred') throw Error('Expected deferred');
  const deferredWorkId = result.workId;
  await runInDurableObject(env.AUTOMATION_STATE.get(accountState(env).id), (_instance, ctx) => ctx.storage.sql.exec("UPDATE events SET data = json_set(data, '$.lease.expiresAt', ?) WHERE event_id = ?", '2000-01-01T00:00:00.000Z', 'workflow:' + deferredWorkId));
  expect(await own.getStatus()).toMatchObject({ preparing: 0, awaitingAgent: 0, expiredWork: 1, state: 'degraded' });
  expect(await other.getStatus()).toMatchObject({ preparing: 0, expiredWork: 0, state: 'ready' });
});

it('recovers an expired processing lock and fences the previous holder', async () => {
  const env = testEnv();
  const repo = accountState(env);
  const actor = { userId: 'owner', clientId: 'client', scopes: ['automation:process'], expiresAt: Date.now() + 600_000 };
  const lease = await repo.reserveWork({ requestId: 'lock-expiry', target: { kind: 'conversation', conversationId: 101 }, mode: 'preview', actor, payloadDigest: 'synthetic' });
  const previous = await repo.beginPreparation(lease);
  const firstError = await durableFailure(env.AUTOMATION_STATE.get(repo.id), instance => instance.beginPreparation(lease));
  expect({ code: firstError.code, retryable: firstError.retryable }).toEqual({ code: 'UPSTREAM_CONFLICT', retryable: true });
  await runInDurableObject(env.AUTOMATION_STATE.get(repo.id), (_instance, ctx) => ctx.storage.sql.exec('UPDATE preparation_locks SET expires_at = 0 WHERE work_id = ?', lease.workId));
  const next = await repo.beginPreparation(lease);
  expect(next).not.toBe(previous);
  const staleError = await durableFailure(env.AUTOMATION_STATE.get(repo.id), instance => instance.renewPreparation(lease, previous));
  expect({ code: staleError.code }).toEqual({ code: 'UPSTREAM_CONFLICT' });
  await repo.endPreparation(lease, previous);
  await repo.renewPreparation(lease, next);
  await repo.endPreparation(lease, next);
  expect(await repo.beginPreparation(lease)).not.toBe(next);
});

it('resets the no-progress counter when a later retry reaches a new durable stage', async () => {
  const env = testEnv({ AGENDOR_CHAT_TOKEN: 'synthetic', AGENDOR_CHAT_ACCOUNT_ID: '123' });
  let phase = 0;
  budgetMock(env).mockImplementation(async product => phase === 0 || phase === 1 && product === 'crm'
    ? { allowed: false, retryAt: Date.now() + 10_000 }
    : { allowed: true, reservationId: 'synthetic' });
  vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/conversations/101')) return Response.json({ id: 101, inbox_id: 4101, meta: { sender: { id: 2 } } });
    if (url.pathname.endsWith('/contacts/2')) return Response.json({ payload: { id: 2, email: 'synthetic@example.com' } });
    if (url.pathname.endsWith('/messages')) return Response.json({ payload: [{ id: 201, conversation_id: 101, content: 'synthetic' }] });
    return Response.json({ data: [] });
  }));
  const actor = { userId: 'synthetic', clientId: 'progress', scopes: ['automation:process', 'automation:read', 'chat:read', 'crm:read'], expiresAt: Date.now() + 600_000 };
  const service = createAutomationService(env, actor);
  const request = { requestId: 'progress-test', target: { kind: 'conversation' as const, conversationId: 101 }, mode: 'preview' as const, limits: { maxMessagePages: 1, maxAttachmentPages: 0 } };
  const first = await service.prepare(request);
  expect(first).toMatchObject({ state: 'deferred', reason: 'UPSTREAM_RATE_LIMITED', noProgressAttempts: 1, progress: { stage: 'conversation', messagePages: 0 } });
  if (first.state !== 'deferred') throw Error('Expected first deferral');
  const resume = { requestId: request.requestId, workId: first.workId, leaseToken: first.leaseToken!, continuation: first.continuation! };
  const unlock = () => runInDurableObject(env.AUTOMATION_STATE.get(accountState(env).id), (_instance, ctx) => ctx.storage.sql.exec("UPDATE events SET data = json_set(data, '$.preparationDeferral.nextRetryAt', ?) WHERE event_id = ?", '2000-01-01T00:00:00.000Z', 'workflow:' + first.workId));
  phase = 1; await unlock();
  const second = await service.prepare(resume);
  expect(second).toMatchObject({ state: 'deferred', workId: first.workId, reason: 'UPSTREAM_RATE_LIMITED', noProgressAttempts: 1, progress: { stage: 'candidates', messagePages: 1, messages: 1 } });
  phase = 2; await unlock();
  const ready = await service.prepare(resume);
  expect(ready).toMatchObject({ state: 'ready', work: { workId: first.workId, coverage: { complete: false, missingReasons: expect.arrayContaining(['attachment_page_limit']) } } });
});

it('reports a Chat timeout without exposing upstream error text', async () => {
  const env = testEnv({ AGENDOR_CHAT_TOKEN: 'synthetic', AGENDOR_CHAT_ACCOUNT_ID: '123' });
  budgetMock(env).mockResolvedValue({ allowed: true, reservationId: 'test' });
  const adapter = chat.createAgendorChatClient(env);
  vi.spyOn(chat, 'createAgendorChatClient').mockReturnValue({
    ...adapter,
    getConversation: async () => { throw new SafeError('UPSTREAM_TIMEOUT', 'synthetic private upstream body', true); },
  });
  const actor = { userId: 'synthetic', clientId: 'timeout', scopes: ['automation:process', 'automation:read', 'chat:read', 'crm:read'], expiresAt: Date.now() + 600_000 };
  const service = createAutomationService(env, actor);
  const result = await service.prepare({ requestId: 'timeout', target: { kind: 'conversation', conversationId: 101 }, mode: 'preview' });
  expect(result).toMatchObject({ state: 'deferred', reason: 'UPSTREAM_TIMEOUT', progress: { stage: 'conversation' } });
  expect(JSON.stringify(result)).not.toContain('private upstream body');
  const audit = await service.getAudit({ limit: 100 });
  expect(audit.entries.some(entry => entry.action === 'preparation_deferred_UPSTREAM_TIMEOUT')).toBe(true);
  expect(JSON.stringify(audit)).not.toContain('private upstream body');
});
