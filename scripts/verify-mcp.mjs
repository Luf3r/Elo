import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

if (existsSync('.dev.vars')) process.loadEnvFile('.dev.vars');
const target = new URL(process.env.MCP_URL ?? 'http://127.0.0.1:8787/mcp');
assert(target.pathname === '/mcp' && !target.username && !target.password && !target.search && !target.hash, 'Use an exact /mcp URL without credentials or query.');
assert((target.protocol === 'https:' && target.hostname.endsWith('.workers.dev')) ||
  (target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)), 'Only local HTTP or HTTPS workers.dev targets are allowed.');
assert(process.env.MCP_TEST_TOKEN, 'Configure MCP_TEST_TOKEN locally.');

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
      '--header', `Authorization: Bearer ${process.env.MCP_TEST_TOKEN}`, '--method', method,
      ...(tool ? ['--tool-name', tool, '--tool-args-json', JSON.stringify(args)] : []),
    ]);
  } finally { process.stdout.write = output; }
  assert(!captured.includes(process.env.AGENDOR_CRM_TOKEN ?? '__unused_token__'), 'Upstream credential appeared in an MCP result.');
  assert(!captured.includes(process.env.MCP_TEST_TOKEN), 'MCP credential appeared in an MCP result.');
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
assert.equal(listed.tools.length, 8);
await inspect('tools/call', 'server_status');
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
console.log(JSON.stringify({ target: target.href, health: 'PASS', authentication: 'PASS', inspector: '2.11.0', tools: 8, realCrmReads: 4, secretsInResults: false }));
