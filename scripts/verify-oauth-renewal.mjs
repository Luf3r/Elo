import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { origin, resource, sessionPath } from './oauth-session.mjs';

// Operates only on this MCP's existing local verification session; never prints credentials.
const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
assert.equal(session.issuer, origin);
assert.equal(session.resource, resource);
assert.equal(typeof session.clientId, 'string');
assert.equal(typeof session.refreshToken, 'string');
const request = async (path, init = {}) => {
  const url = new URL(path, origin);
  assert.equal(url.origin, origin);
  return fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
};

assert.equal((await request('/health')).status, 200);
const discovery = await request('/.well-known/oauth-authorization-server');
assert.equal(discovery.status, 200);
const metadata = await discovery.json();
assert(metadata.grant_types_supported.includes('refresh_token'));
assert(metadata.scopes_supported.includes('offline_access'));

const response = await request('/token', { method: 'POST', body: new URLSearchParams({
  grant_type: 'refresh_token', client_id: session.clientId, refresh_token: session.refreshToken, resource,
}) });
assert.equal(response.status, 200, 'Existing authorized verification session must refresh.');
const token = await response.json();
assert.equal(typeof token.access_token, 'string');
assert.equal(typeof token.refresh_token, 'string');
assert.notEqual(token.refresh_token, session.refreshToken);
assert.equal(token.resource, resource);
assert.equal(token.token_type.toLowerCase(), 'bearer');
assert(Number.isFinite(token.expires_in) && token.expires_in > 0);
// Save the rotated credential immediately, including when a subsequent verification fails.
writeFileSync(sessionPath, JSON.stringify({ ...session, accessToken: token.access_token,
  refreshToken: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000 }), { mode: 0o600 });
assert.equal(token.expires_in, 24 * 60 * 60);

const tools = await request('/mcp', { method: 'POST', headers: {
  Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
}, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
assert.equal(tools.status, 200, 'Refreshed access token must reach MCP.');
await tools.body?.cancel();
const rejected = await request('/mcp', { headers: { Authorization: 'Bearer invalid-verification-token' } });
assert.equal(rejected.status, 401);
assert(rejected.headers.get('www-authenticate')?.includes('resource_metadata='));
await rejected.body?.cancel();

// Reuse the authorized verifier's registered callback; do not create a new production client.
const authorization = new URL(readFileSync('.tooling/oauth-login-url.txt', 'utf8').trim());
assert.equal(authorization.origin, origin);
assert.equal(authorization.pathname, '/authorize');
assert.equal(authorization.searchParams.get('client_id'), session.clientId);
authorization.searchParams.set('scope', 'crm:read');
authorization.searchParams.set('state', randomBytes(32).toString('base64url'));
authorization.searchParams.set('code_challenge', createHash('sha256').update(randomBytes(48)).digest('base64url'));
authorization.searchParams.set('code_challenge_method', 'S256');
const consent = await request(authorization);
assert.equal(consent.status, 200);
const html = await consent.text();
assert(html.includes('offline_access') && html.includes('35 dias') && html.includes('24 horas'));
assert(html.includes('Permissões: crm:read, offline_access.'));

console.log(JSON.stringify({ health: 'PASS', refresh: 'PASS', accessLifetimeHours: 24,
  rotation: 'PASS', refreshedMcpAccess: 'PASS', invalidTokenRejected: 'PASS',
  consentForClientOmittingOfflineAccess: 'PASS', grantLifetimeDays: 35 }));
