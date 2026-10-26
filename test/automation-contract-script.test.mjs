import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { discoverAutomationContracts } from '../scripts/discover-automation-contracts.mjs';
import { syntheticContracts as fixtures } from './fixtures/automation-contracts.ts';

function transport(calls) {
  return async request => {
    calls.push(request);
    const url = new URL(request.url);
    if (url.pathname.endsWith('/profile')) return Response.json(fixtures.profile);
    if (url.pathname.endsWith('/messages')) return Response.json(fixtures.messages);
    if (url.pathname.endsWith('/attachments')) return Response.json(fixtures.attachments);
    if (url.pathname.endsWith('/contacts')) return Response.json(fixtures.contacts);
    if (url.pathname.endsWith('/conversations')) return Response.json(fixtures.conversations);
    return Response.json(fixtures.catalog);
  };
}

test('discovery uses fixed GET reads and emits no secrets or customer values, including dynamic keys', async () => {
  const calls = [], output = [];
  const upstream = transport(calls);
  const report = await discoverAutomationContracts({
    request: async request => {
      const response = await upstream(request);
      const body = await response.json();
      body['unit-agendor-key'] = { 'SYNTHETIC dynamic name': 'SYNTHETIC value' };
      return Response.json(body);
    }, emit: line => output.push(line),
  });
  assert.ok(calls.length > 4 && calls.length <= 20);
  assert.ok(calls.every(call => call.method === 'GET' && call.redirect === 'manual'));
  assert.ok(calls.every(call => ['https://chat.agendor.com.br', 'https://api.agendor.com.br'].includes(new URL(call.url).origin)));
  assert.ok(calls.some(call => new URL(call.url).searchParams.has('after')));
  assert.ok(calls.every(call => !/[?&](page|before|cursor)=/.test(call.url)));
  const serialized = JSON.stringify([report, output]);
  for (const canary of ['unit-agendor-key', 'SYNTHETIC', '812345', '823456', '834567', '845678', '856789', '867890', 'example.invalid']) assert.equal(serialized.includes(canary), false);
  assert.equal(report.contacts.status, 'verified');
  assert.equal(report.attachments.status, 'verified');
  assert.equal(report.customFields.status, 'verified');
  for (const key of ['chatMessageAfter', 'chatHistory', 'conversationDiscovery', 'collectionWriteSemantics']) assert.equal(report[key].status, 'unverified');
  assert.ok(Object.values(report).every(capability => capability.references.length > 0));
});

test('HTTP errors, malformed shapes and missing data mean unverified, never unsupported', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const report = await discoverAutomationContracts({ request: async () => new Response('unit-agendor-key', { status }), emit: () => {} });
    assert.ok(Object.values(report).every(capability => capability.status === 'unverified'));
  }
  const report = await discoverAutomationContracts({ request: async () => Response.json({ unexpected: [] }), emit: () => {} });
  assert.equal(report.contacts.status, 'unverified');
  assert.equal(report.customFields.status, 'unverified');
});

test('redirects are not followed and thrown transport details are not emitted', async () => {
  const calls = [], output = [];
  const report = await discoverAutomationContracts({ request: async req => {
    calls.push(req);
    if (req.url.includes('/profile')) return new Response(null, { status: 302, headers: { location: 'https://example.invalid/steal' } });
    throw new Error('unit-agendor-key SYNTHETIC upstream error');
  }, emit: line => output.push(line) });
  assert.ok(calls.every(req => req.redirect === 'manual'));
  assert.ok(calls.every(req => !req.url.includes('example.invalid')));
  assert.equal(JSON.stringify([report, output]).includes('unit-agendor-key'), false);
});

test('responses are byte bounded including streamed bodies and invalid JSON stays unverified', async () => {
  for (const response of [() => new Response('x'.repeat(1024 * 1024 + 1)), () => new Response('bad json'), () => new Response(null, { headers: { 'content-length': String(1024 * 1024 + 1) } })]) {
    const report = await discoverAutomationContracts({ request: async () => response(), emit: () => {} });
    assert.equal(report.customFields.status, 'unverified');
  }
});

test('timeout aborts both transport and stalled response streams', async () => {
  for (const stalledBody of [false, true]) {
    const signals = [], cancelled = [];
    const report = await discoverAutomationContracts({ timeoutMs: 5, request: req => {
      signals.push(req.signal);
      if (stalledBody) return Promise.resolve(new Response(new ReadableStream({ start() {}, cancel() { cancelled.push(true); } })));
      return new Promise(() => {});
    }, emit: () => {} });
    assert.ok(signals.length > 0 && signals.every(signal => signal.aborted), JSON.stringify({ stalledBody, states: signals.map(signal => signal.aborted), evidence: report.customFields.evidence }));
    if (stalledBody) assert.equal(cancelled.length, signals.length);
    assert.equal(report.customFields.status, 'unverified');
  }
});

test('CLI requires explicit opt-in and rejects arguments before reading credentials or network', () => {
  for (const args of [[], ['--token', 'unit-agendor-key'], ['--live', '--token', 'unit-agendor-key']]) {
    const child = spawnSync(process.execPath, ['scripts/discover-automation-contracts.mjs', ...args], { encoding: 'utf8' });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /Use only --live/);
    assert.equal(child.stderr.includes('unit-agendor-key'), false);
  }
});
