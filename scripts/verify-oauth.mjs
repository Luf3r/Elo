import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { origin, resource } from './oauth-session.mjs';
if (existsSync('.dev.vars')) process.loadEnvFile('.dev.vars');
const meta = await fetch(origin + '/.well-known/oauth-protected-resource/mcp', { signal: AbortSignal.timeout(15_000) });
assert.equal(meta.status, 200);
const data = await meta.json();
assert.equal(data.resource, resource);
assert.deepEqual(data.authorization_servers, [origin]);
const r = await fetch(resource, {
  headers: { Authorization: `Bearer ${process.env.MCP_TEST_TOKEN ?? 'invalid-static-token'}` },
  signal: AbortSignal.timeout(15_000),
});
assert.equal(r.status, 401);
assert(r.headers.get('www-authenticate')?.includes('resource_metadata='));
await r.body?.cancel();
const config = await fetch(origin + '/.well-known/oauth-authorization-server', { signal: AbortSignal.timeout(15_000) });
const auth = await config.json();
assert.equal(auth.issuer, origin);
assert(auth.code_challenge_methods_supported.includes('S256'));
assert(auth.scopes_supported.includes('offline_access'));
assert(['crm:read', 'crm:write', 'chat:read'].every((scope) => auth.scopes_supported.includes(scope)));
assert.equal(auth.client_id_metadata_document_supported, false);
console.log(
  JSON.stringify({
    resource,
    discovery: 'PASS',
    staticCredentialRejected: 'PASS',
    PKCE: 'S256',
    CIMD: auth.client_id_metadata_document_supported,
    DCR: auth.registration_endpoint,
    authorization: 'Browser login required for end-to-end verification',
  }),
);
