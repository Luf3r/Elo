import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { acceptChatHint } from '../src/automation/ingress';
import type { Env } from '../src/env';

const request = (body: unknown) => new Request('https://example.test/automation/chat-events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const hintEnv = () => ({ ...env, AGENDOR_CHAT_ACCOUNT_ID: '7001', AUTOMATION_CHAT_HINTS_ENABLED: 'true' } as Env);
const hint = { eventId: 'event-1', accountId: '7001', conversationId: 101 };
it('keeps unverified webhook ingress disabled unless explicitly configured as hints', async () => {
  expect((await acceptChatHint(request(hint), { ...hintEnv(), AUTOMATION_CHAT_HINTS_ENABLED: 'false' })).status).toBe(404);
});
it('rejects malformed, foreign and oversized hint bodies before persistence', async () => {
  expect((await acceptChatHint(request({ ...hint, accountId: 'other' }), hintEnv())).status).toBe(400);
  expect((await acceptChatHint(request({ ...hint, message: 'Never canonical evidence' }), hintEnv())).status).toBe(400);
  expect((await acceptChatHint(request({ ...hint, eventId: 'x'.repeat(9000) }), hintEnv())).status).toBe(413);
});
it('deduplicates hints and persists only review references without facts or CRM effects', async () => {
  const runtime = hintEnv(); const stub = runtime.AUTOMATION_STATE.getByName('elotenant');
  const first = await acceptChatHint(request(hint), runtime); const second = await acceptChatHint(request(hint), runtime);
  expect(first.status).toBe(202); expect(await second.json()).toMatchObject({ state: 'duplicate', requiresCanonicalRead: true });
  const rows = await runInDurableObject(stub, (_instance, ctx) => ({ hints: ctx.storage.sql.exec('SELECT conversation_id FROM chat_hints').toArray(), facts: ctx.storage.sql.exec('SELECT * FROM facts').toArray(), operations: ctx.storage.sql.exec('SELECT * FROM execution_operations').toArray() }));
  expect(rows.hints).toEqual([{ conversation_id: 101 }]); expect(rows.facts).toEqual([]); expect(rows.operations).toEqual([]);
  const reviews = await stub.listReviews({ limit: 20 }, { userId: 'operator-1', clientId: 'client-1' });
  expect(reviews).toMatchObject({ chatHints: [{ conversationId: 101, requiresCanonicalRead: true }] });
});
it('bounds unsigned ingress per account and rejects reused event ids with changed targets', async () => {
  const runtime = hintEnv();
  await runInDurableObject(runtime.AUTOMATION_STATE.getByName('elotenant'), (_instance, ctx) => { ctx.storage.sql.exec('DELETE FROM chat_hints'); });
  expect((await acceptChatHint(request({ ...hint, eventId: 'conflict' }), runtime)).status).toBe(202);
  expect((await acceptChatHint(request({ ...hint, eventId: 'conflict', conversationId: 102 }), runtime)).status).toBe(409);
  for (let i = 1; i < 30; i++) expect((await acceptChatHint(request({ ...hint, eventId: 'quota-' + i }), runtime)).status).toBe(202);
  expect((await acceptChatHint(request({ ...hint, eventId: 'over-quota' }), runtime)).status).toBe(429);
});
