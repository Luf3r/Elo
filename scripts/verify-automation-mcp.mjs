import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateMcpTarget, readSession } from './oauth-session.mjs';

const MAX_BYTES = 512 * 1024;
const codes = new Set(['MCP_UNAUTHORIZED', 'INVALID_INPUT', 'UPSTREAM_TIMEOUT', 'UPSTREAM_RATE_LIMITED', 'RESULT_TOO_LARGE']);
const safeState = value => ['ready', 'review', 'noop', 'continue', 'deferred', 'queued', 'applied', 'uncertain', 'authorization_expired'].includes(value) ? value : 'failed';
export const commandDigest = command => createHash('sha256').update(JSON.stringify(command)).digest('hex');
const pilotValid = (pilot, conversationId) => pilot && typeof pilot.approvedBy === 'string' && pilot.approvedBy.trim() &&
  Date.parse(pilot.expiresAt) > Date.now() && pilot.conversations?.some(c => c.id === conversationId && Number.isSafeInteger(c.inboxId) && c.inboxId > 0) &&
  typeof pilot.requestId === 'string' && pilot.requestId.length > 0 && pilot.requestId.length <= 200 &&
  Array.isArray(pilot.records) && Array.isArray(pilot.operations) && pilot.operations.length > 0 && pilot.operations.length <= 20;

/** No IO by default. The injected client makes every attempted MCP call observable. */
export async function runVerification({ call, read = false, write = false, conversationId, analysis, pilot, secrets = [] } = {}) {
  if (write) assert(read && analysis && pilotValid(pilot, conversationId), 'PILOT_AUTHORIZATION_REQUIRED');
  if (!read) return { state: 'offline', steps: [], remoteCalls: 0 };
  assert(Number.isSafeInteger(conversationId) && conversationId > 0, 'Use one explicit conversation ID.');
  const steps = [];
  async function invoke(name, args = {}) {
    const result = await call(name, args);
    const text = JSON.stringify(result);
    assert(!secrets.filter(s => s).some(s => text.includes(s)), 'RESULT_REDACTION_FAILED');
    if (Buffer.byteLength(text) > MAX_BYTES) { steps.push({ tool: name, code: 'RESULT_TOO_LARGE' }); return undefined; }
    if (result?.isError || result?.error) {
      let code = result.error?.code;
      try { code ??= JSON.parse(result.content?.find(c => c.type === 'text')?.text ?? '{}').error?.code; } catch {}
      steps.push({ tool: name, code: codes.has(code) ? code : 'MCP_ERROR' }); return undefined;
    }
    let body = result;
    if (Array.isArray(result?.content)) {
      try { body = JSON.parse(result.content.find(c => c.type === 'text')?.text ?? '{}'); } catch { steps.push({ tool: name, code: 'MALFORMED_RESULT' }); return undefined; }
    }
    steps.push({ tool: name, code: 'OK', ...(Array.isArray(body?.orderedCommands) ? { commands: body.orderedCommands.length } : {}) });
    return body;
  }
  if (!await invoke('automation_get_status')) return { state: 'failed', steps };
  let prepared = await invoke('automation_prepare_sync', { requestId: write ? pilot.requestId : `verify:${randomUUID()}`, target: { kind: 'conversation', conversationId }, mode: write ? 'apply' : 'preview' });
  for (let i = 0; prepared?.state === 'continue' && i < 10; i++) {
    prepared = await invoke('automation_prepare_sync', { requestId: `verify:${randomUUID()}`, workId: prepared.workId, leaseToken: prepared.leaseToken, continuation: prepared.continuation });
  }
  if (prepared?.state !== 'ready' || !analysis) return { state: safeState(prepared?.state), steps };
  const work = prepared.work;
  const plan = await invoke('automation_submit_analysis', { workId: work.workId, leaseToken: work.leaseToken, expectedSnapshotVersion: work.snapshotVersion, expectedContextVersion: work.contextVersion, analysis });
  if (write) {
    assert(plan?.state === 'ready' && plan.orderedCommands.length > 0 && pilotValid(pilot, conversationId), 'PILOT_PLAN_NOT_AUTHORIZED');
    for (const command of plan.orderedCommands) {
      assert(pilot.operations.some(o => o.commandKey === command.commandKey && o.kind === command.kind && o.sha256 === commandDigest(command)), 'PILOT_COMMAND_NOT_AUTHORIZED');
      if (command.target?.id) assert(pilot.records.some(r => r.kind === command.target.kind && r.id === command.target.id), 'PILOT_RECORD_NOT_AUTHORIZED');
    }
    await invoke('automation_apply_plan', { planId: plan.planId, planVersion: plan.version, requestId: `pilot:${randomUUID()}` });
  }
  return { state: safeState(plan?.state), steps };
}

async function main() {
  const args = process.argv.slice(2);
  const known = new Set(['--read', '--write', '--conversation', '--analysis', '--pilot']);
  for (let i = 0; i < args.length; i++) { assert(known.has(args[i]), 'Unknown verifier option.'); if (!['--read', '--write'].includes(args[i])) { assert(args[i + 1] && !args[i + 1].startsWith('--'), 'Option requires a value.'); i++; } }
  const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const read = args.includes('--read'); const write = args.includes('--write');
  if (!read && !write) { console.log(JSON.stringify(await runVerification())); return; }
  const load = flag => value(flag) ? JSON.parse(readFileSync(value(flag), 'utf8')) : undefined;
  const conversationId = Number(value('--conversation')); const analysis = load('--analysis'); const pilot = load('--pilot');
  assert(read && Number.isSafeInteger(conversationId) && conversationId > 0, 'Use --read and one explicit conversation.');
  if (write) assert(analysis && pilotValid(pilot, conversationId), 'PILOT_AUTHORIZATION_REQUIRED');
  const target = validateMcpTarget(process.env.MCP_URL);
  const session = readSession();
  const secrets = [session.accessToken, process.env.AGENDOR_CRM_TOKEN, process.env.AGENDOR_CHAT_TOKEN];
  // SDK transport negotiates initialization and invokes the real MCP boundary.
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'elo-automation-verifier', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(target, { requestInit: { headers: { Authorization: `Bearer ${session.accessToken}` }, redirect: 'error' } }));
    const summary = await runVerification({ call: (name, arguments_) => client.callTool({ name, arguments: arguments_ }), read, write, conversationId, analysis, pilot, secrets });
    console.log(JSON.stringify(summary));
    if (summary.state === 'failed') process.exitCode = 1;
  } finally { await client.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('AUTOMATION_VERIFICATION_FAILED: check authorization, options and bounded pilot; response bodies are suppressed.'); process.exitCode = 1; });
}
