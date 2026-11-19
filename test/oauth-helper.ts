import { env as runtimeEnv, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { OAuthProvider, type OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { vi } from 'vitest';
import type { Env } from '../src/env';
import { ORIGIN, RESOURCE } from '../src/oauth/config';
import { testEnv } from './helpers';
import { readResponseJson } from './helpers/json';

export function oauthEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...testEnv(),
    OAUTH_KV: (runtimeEnv as { OAUTH_KV: KVNamespace }).OAUTH_KV,
    OAUTH_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    ACCESS_CLIENT_ID: 'unit-client',
    ACCESS_CLIENT_SECRET: 'unit-secret',
    ACCESS_ISSUER: 'https://elo-unit.cloudflareaccess.com',
    ACCESS_AUTHORIZATION_URL:
      'https://elo-unit.cloudflareaccess.com/cdn-cgi/access/sso/oidc/unit-client/authorization',
    ACCESS_TOKEN_URL: 'https://elo-unit.cloudflareaccess.com/cdn-cgi/access/sso/oidc/unit-client/token',
    ACCESS_JWKS_URL: 'https://elo-unit.cloudflareaccess.com/cdn-cgi/access/sso/oidc/unit-client/jwks',
    ...overrides,
  };
}
export const baseOptions = {
  apiRoute: '/mcp',
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  resourceMetadata: { resource: RESOURCE, authorization_servers: [ORIGIN] },
  scopesSupported: ['crm:read', 'chat:read', 'crm:write', 'offline_access'],
  onError: () => undefined,
} satisfies Partial<OAuthProviderOptions<Env>>;

export function cookies(...responses: Response[]): string {
  const jar = new Map<string, string>();
  for (const r of responses)
    for (const value of r.headers.getSetCookie()) {
      const part = value.split(';')[0]!;
      jar.set(part.split('=')[0]!, part);
    }
  return [...jar.values()].join('; ');
}
export async function sha256(value: string): Promise<string> {
  return btoa(
    String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))),
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}
export async function providerFetch(
  provider: OAuthProvider<Env>,
  env: Env,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const ctx = createExecutionContext();
  const r = await provider.fetch(new Request(path.startsWith('https:') ? path : ORIGIN + path, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return r;
}
export async function startAuthorization(
  provider: OAuthProvider<Env>,
  env: Env,
  clientName = 'Unit client',
  scope = 'crm:read offline_access',
) {
  const registered = await providerFetch(provider, env, '/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: ['https://client.example/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (registered.status !== 201) throw new Error('Test client registration failed: ' + (await registered.text()));
  const raw = await readResponseJson<{ client_id: string }>(registered);
  const client = { clientId: raw.client_id };
  const verifier = 'unit-verifier-01234567890123456789012345678901234567890';
  const query = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: 'https://client.example/callback',
    resource: RESOURCE,
    response_type: 'code',
    scope,
    state: 'client-state',
    code_challenge: await sha256(verifier),
    code_challenge_method: 'S256',
  });
  const response = await providerFetch(provider, env, '/authorize?' + query.toString());
  const html = await response.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  return { client, verifier, response, html, handle };
}
export async function simulateAccess(nonce: string, overrides: Record<string, unknown> = {}) {
  const keys = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'login-key', alg: 'RS256' };
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    sub: 'owner-sub',
    email: 'owner@elo.example',
    nonce,
    iss: 'https://elo-unit.cloudflareaccess.com',
    aud: 'unit-client',
    iat: now,
    exp: now + 300,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'login-key' })
    .sign(keys.privateKey);
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/token')) return Response.json({ id_token: token, access_token: 'upstream-not-for-client' });
    if (url.endsWith('/jwks')) return Response.json({ keys: [jwk] });
    throw new Error('Unexpected upstream call');
  });
}
