import assert from 'node:assert/strict';
import { isEntrypoint } from './lib/args.ts';
import { assertUnauthorizedMcpRequests } from './lib/mcp-client.ts';
import { origin, resource } from './lib/oauth-session.ts';

interface ProtectedResourceMetadata {
  resource?: unknown;
  authorization_servers?: unknown;
}

interface AuthorizationServerMetadata {
  issuer?: unknown;
  code_challenge_methods_supported?: unknown;
  scopes_supported?: unknown;
  client_id_metadata_document_supported?: unknown;
  registration_endpoint?: unknown;
}

/** Verify OAuth protected-resource discovery, authorization-server metadata, and unauthenticated 401 rejections. */
export async function verifyOauth(): Promise<void> {
  const meta = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`, {
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(meta.status, 200);
  const data = await meta.json<ProtectedResourceMetadata>();
  assert.equal(data.resource, resource);
  assert.deepEqual(data.authorization_servers, [origin]);

  await assertUnauthorizedMcpRequests(resource, [{}, { Authorization: 'Bearer invalid-static-token' }], {
    method: 'GET',
    requireWwwAuthenticate: true,
  });

  const config = await fetch(`${origin}/.well-known/oauth-authorization-server`, {
    signal: AbortSignal.timeout(15_000),
  });
  const auth = await config.json<AuthorizationServerMetadata>();
  assert.equal(auth.issuer, origin);
  assert(
    Array.isArray(auth.code_challenge_methods_supported) && auth.code_challenge_methods_supported.includes('S256'),
  );
  assert(Array.isArray(auth.scopes_supported) && auth.scopes_supported.includes('offline_access'));
  const scopesSupported = auth.scopes_supported;
  assert(['crm:read', 'crm:write', 'chat:read'].every((scope) => scopesSupported.includes(scope)));
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
}

if (isEntrypoint(import.meta.url)) {
  verifyOauth().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
