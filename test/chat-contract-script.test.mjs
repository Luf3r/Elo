import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyChatContract } from '../scripts/verify-chat-contract.mjs';

test('verifier uses only pinned GET routes and redacts tokens and customer values', async () => {
  const calls = [];
  const output = [];
  const fetchImpl = async (request) => {
    calls.push(request);
    const path = new URL(request.url).pathname;
    if (path.endsWith('/profile')) return Response.json({ id: 5, account_id: 123, available_name: 'Private account', email: 'private@example.com' });
    if (path.endsWith('/456/messages')) return Response.json({ data: [{ id: 789, content: 'Private message body' }] });
    if (path.endsWith('/accounts/123/conversations/456')) return Response.json({ id: 456, messages: [{ content: 'Private conversation text' }] });
    return Response.json({ data: { meta: { all_count: 1 }, payload: [{ id: 456, last_non_activity_message: { content: 'Private message body' } }] } });
  };
  await verifyChatContract({ token: 'secret-chat-token', fetchImpl, write: line => output.push(line) });
  assert.equal(calls.length, 4);
  assert.ok(calls.every(request => request.method === 'GET'));
  assert.ok(calls.every(request => new URL(request.url).origin === 'https://chat.agendor.com.br'));
  assert.ok(calls[0].url.endsWith('/api/v1/profile'));
  assert.ok(calls[1].url.endsWith('/accounts/123/conversations'));
  assert.ok(calls[2].url.endsWith('/accounts/123/conversations/456'));
  assert.ok(calls[3].url.endsWith('/accounts/123/conversations/456/messages'));
  assert.ok(calls.every(request => request.headers.get('api_access_token') === 'secret-chat-token'));
  const joined = output.join('\n');
  for (const value of ['secret-chat-token', 'Private account', 'private@example.com', 'Private conversation text', 'Private message body']) assert.ok(!joined.includes(value));
  assert.match(joined, /accountIdSource.*profile/);
  assert.match(joined, /idSource.*first conversation on returned page/);
});

test('verifier can persist the profile account ID locally without printing its value', async () => {
  const output = [];
  let stored;
  await verifyChatContract({ token: 'secret', fetchImpl: async () => Response.json({ account_id: 123 }), persistAccountId: value => { stored = value; }, write: line => output.push(line) });
  assert.equal(stored, '123');
  assert.equal(output.join('\\n').includes('123'), false);
});

test('verifier stops if a configured account ID differs from the authenticated profile', async () => {
  const calls = [];
  const output = [];
  await assert.rejects(() => verifyChatContract({ token: 'secret', accountId: '999', fetchImpl: async request => { calls.push(request); return Response.json({ account_id: 123 }); }, write: line => output.push(line) }), /does not match/);
  assert.equal(calls.length, 1);
  assert.equal(output.join('\\n').includes('999'), false);
  assert.equal(output.join('\\n').includes('123'), false);
});

test('verifier stops after profile when the account identifier is unknown', async () => {
  const calls = [];
  await verifyChatContract({ token: 'secret', fetchImpl: async request => { calls.push(request); return Response.json({ profile: { name: 'Private' } }); }, write: () => {} });
  assert.equal(calls.length, 1);
});

test('verifier refuses redirects and sanitizes upstream failures', async () => {
  const output = [];
  await assert.rejects(() => verifyChatContract({ token: 'secret', fetchImpl: async request => { assert.equal(request.redirect, 'manual'); return new Response('private error secret', { status: 500 }); }, write: line => output.push(line) }), /Chat request failed \(500\)/);
  assert.equal(output.join('').includes('private error'), false);
});


test('verifier rejects a real redirect without following it', async () => {
  const calls = [];
  await assert.rejects(() => verifyChatContract({ token: 'secret', fetchImpl: async request => { calls.push(request); return new Response(null, { status: 302, headers: { location: 'https://attacker.example/collect' } }); }, write: () => {} }), /Chat request failed \(302\)/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirect, 'manual');
});

test('verifier enforces the streaming response byte limit', async () => {
  await assert.rejects(() => verifyChatContract({ token: 'secret', fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1)), write: () => {} }), /response exceeded the size limit/);
});

test('verifier aborts a request at its timeout', async () => {
  let signal;
  await assert.rejects(() => verifyChatContract({ token: 'secret', timeoutMs: 25, fetchImpl: request => new Promise((_, reject) => { signal = request.signal; request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }), write: () => {} }), /Chat request timed out/);
  assert.equal(signal.aborted, true);
});
