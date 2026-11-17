import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {validateMcpTarget,readSession} from './oauth-session.mjs';

if (existsSync('.dev.vars')) process.loadEnvFile('.dev.vars');
const target = validateMcpTarget(process.env.MCP_URL);
assert(target.pathname === '/mcp' && !target.username && !target.password && !target.search && !target.hash, 'Use an exact /mcp URL without credentials or query.');
assert((target.protocol === 'https:' && target.hostname.endsWith('.workers.dev')) ||
  (target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)), 'Only local HTTP or HTTPS workers.dev targets are allowed.');
const credential = process.env.MCP_OAUTH_ACCESS_TOKEN ?? readSession().accessToken;
assert(credential, 'Complete OAuth browser login first.');

const { runCli } = await import(pathToFileURL(resolve('node_modules/@modelcontextprotocol/inspector/clients/cli/build/index.js')).href);
const output = process.stdout.write.bind(process.stdout);
async function inspect(method, tool, args = {}) {
  process.stderr.write(`Inspector: ${tool ?? method}\n`);
  let captured = '';
  process.stdout.write = (chunk, encoding, callback) => {
    captured += chunk.toString();
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done) done();
    return true;
  };
  try {
    // Invoke pinned Inspector in-process: the credential never appears in OS argv or a config file.
    await runCli([process.execPath, 'inspector', '--server-url', target.href, '--transport', 'http',
      '--protocol-era', 'modern', '--stored-auth-only', '--connect-timeout', '15000', '--format', 'json', '--quiet',
      '--header', `Authorization: Bearer ${credential}`, '--method', method,
      ...(tool ? ['--tool-name', tool, '--tool-args-json', JSON.stringify(args)] : []),
    ]);
  } finally { process.stdout.write = output; }
  assert(!captured.includes(process.env.AGENDOR_CRM_TOKEN ?? '__unused_token__'), 'Upstream credential appeared in an MCP result.');
  assert(!captured.includes(credential), 'MCP credential appeared in an MCP result.');
  const parsed = JSON.parse(captured.trim());
  const result = parsed.result ?? parsed;
  assert(!result.isError && !parsed.error, 'Inspector returned an MCP error; no record content displayed.');
  return result;
}

const health = await fetch(new URL('/health', target));
assert.equal(health.status, 200);
const requestBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
for (const headers of [{}, { Authorization: 'Bearer intentionally-invalid-token' }]) {
  const response = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: requestBody });
  assert.equal(response.status, 401);
  await response.body?.cancel();
}
const listed = await inspect('tools/list');
const names = listed.tools.map(tool => tool.name);
const requiredTools = ['server_status', 'crm_find_person_by_email', 'crm_search_people', 'crm_search_organizations', 'crm_get_organization', 'crm_search_deals', 'crm_get_deal', 'crm_list_tasks', 'chat_list_conversations', 'chat_get_conversation', 'chat_list_messages'];
const optionalTools = [
  'crm_update_deal', 'crm_update_deal_stage', 'crm_update_person', 'crm_update_organization',
  'crm_get_person', 'crm_get_task', 'crm_get_configuration',
  'chat_search_contacts', 'chat_get_contact', 'chat_list_contact_conversations', 'chat_list_attachments', 'chat_get_attachment',
  'automation_preflight_sync', 'automation_discover_pending', 'automation_prepare_sync', 'automation_submit_analysis', 'automation_apply_plan', 'automation_get_operation',
  'automation_get_customer_context', 'automation_list_reviews', 'automation_resolve_review', 'automation_get_status',
  'automation_list_audit', 'automation_update_policy', 'automation_reprocess',
  'crm_create_organization', 'crm_create_person', 'crm_create_deal', 'crm_create_task',
  'crm_enrich_organization', 'crm_enrich_person', 'crm_enrich_deal', 'crm_update_task',
];
assert(requiredTools.every(name => names.includes(name)), 'Required production tools are missing.');
assert(names.every(name => requiredTools.includes(name) || optionalTools.includes(name)), 'Unexpected MCP tool is exposed.');
await inspect('tools/call', 'server_status');
await inspect('tools/call', 'chat_list_conversations');
for (const [tool, args] of [
  ['crm_search_people', { perPage: 1 }],
  ['crm_search_organizations', { perPage: 1 }],
  ['crm_search_deals', { perPage: 1 }],
  ['crm_list_tasks', { perPage: 1, updatedDateGt: new Date(Date.now() - 86_400_000).toISOString() }],
]) {
  await new Promise(resolve => setTimeout(resolve, 400));
  const result = await inspect('tools/call', tool, args);
  assert(Array.isArray(JSON.parse(result.content[0].text).items));
}
console.log(JSON.stringify({ target: target.href, health: 'PASS', authentication: 'PASS', inspector: '2.11.0', tools: names.length, realCrmReads: 4, secretsInResults: false }));
