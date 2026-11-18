import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { isEntrypoint } from './lib/args.ts';
import { assertUnauthorizedMcpRequests, probeHealth } from './lib/mcp-client.ts';
import { origin, readLoginUrl, readStoredSession, resource, writeSession } from './lib/oauth-session.ts';

interface AuthServerDiscovery {
  grant_types_supported?: unknown;
  scopes_supported?: unknown;
}

interface RefreshTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  resource?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
}

async function requestOrigin(pathOrUrl: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(pathOrUrl, origin);
  assert.equal(url.origin, origin);
  return fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
}

/** Verify OAuth refresh-token rotation, 24h access TTL, MCP access, and 35-day consent text. */
export async function verifyOauthRenewal(): Promise<void> {
  // Operates only on this MCP's existing local verification session; never prints credentials.
  const session = readStoredSession();
  assert.equal(session.issuer, origin);
  assert.equal(session.resource, resource);
  assert.equal(typeof session.clientId, 'string');
  assert.equal(typeof session.refreshToken, 'string');
  const clientId = session.clientId as string;
  const refreshToken = session.refreshToken as string;

  assert.equal((await probeHealth(origin)).status, 200);
  const discovery = await requestOrigin('/.well-known/oauth-authorization-server');
  assert.equal(discovery.status, 200);
  const metadata = await discovery.json<AuthServerDiscovery>();
  assert(Array.isArray(metadata.grant_types_supported) && metadata.grant_types_supported.includes('refresh_token'));
  assert(Array.isArray(metadata.scopes_supported) && metadata.scopes_supported.includes('offline_access'));

  const response = await requestOrigin('/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
      resource,
    }),
  });
  assert.equal(response.status, 200, 'Existing authorized verification session must refresh.');
  const token = await response.json<RefreshTokenResponse>();
  assert.equal(typeof token.access_token, 'string');
  assert.equal(typeof token.refresh_token, 'string');
  assert.notEqual(token.refresh_token, refreshToken);
  assert.equal(token.resource, resource);
  assert.equal(typeof token.token_type, 'string');
  assert.equal((token.token_type as string).toLowerCase(), 'bearer');
  assert(typeof token.expires_in === 'number' && Number.isFinite(token.expires_in) && token.expires_in > 0);
  const nextAccessToken = token.access_token as string;
  const nextRefreshToken = token.refresh_token as string;

  // Save the rotated credential immediately, including when a subsequent verification fails.
  writeSession({
    ...session,
    accessToken: nextAccessToken,
    refreshToken: nextRefreshToken,
    expiresAt: Date.now() + token.expires_in * 1000,
  });
  assert.equal(token.expires_in, 24 * 60 * 60);

  const tools = await requestOrigin('/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${nextAccessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(tools.status, 200, 'Refreshed access token must reach MCP.');
  await tools.body?.cancel();

  await assertUnauthorizedMcpRequests(resource, [{ Authorization: 'Bearer invalid-verification-token' }], {
    method: 'GET',
    requireWwwAuthenticate: true,
  });

  // Reuse the authorized verifier's registered callback; do not create a new production client.
  const authorization = new URL(readLoginUrl());
  assert.equal(authorization.origin, origin);
  assert.equal(authorization.pathname, '/authorize');
  assert.equal(authorization.searchParams.get('client_id'), clientId);
  authorization.searchParams.set('scope', 'crm:read');
  authorization.searchParams.set('state', randomBytes(32).toString('base64url'));
  authorization.searchParams.set('code_challenge', createHash('sha256').update(randomBytes(48)).digest('base64url'));
  authorization.searchParams.set('code_challenge_method', 'S256');
  const consent = await requestOrigin(authorization);
  assert.equal(consent.status, 200);
  const html = await consent.text();
  assert(html.includes('offline_access') && html.includes('35 dias') && html.includes('24 horas'));
  assert(html.includes('Permissões: crm:read, offline_access.'));

  console.log(
    JSON.stringify({
      health: 'PASS',
      refresh: 'PASS',
      accessLifetimeHours: 24,
      rotation: 'PASS',
      refreshedMcpAccess: 'PASS',
      invalidTokenRejected: 'PASS',
      consentForClientOmittingOfflineAccess: 'PASS',
      grantLifetimeDays: 35,
    }),
  );
}

if (isEntrypoint(import.meta.url)) {
  verifyOauthRenewal().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
