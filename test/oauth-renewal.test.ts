import { describe, expect, it, vi } from 'vitest';
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { oauthOptions } from '../src/oauth/provider';
import { RESOURCE } from '../src/oauth/config';
import { cookies, oauthEnv, providerFetch, simulateAccess, startAuthorization } from './oauth-helper';
import { issueTestToken } from './oauth-token';

const DAY = 24 * 60 * 60;
type Token = { access_token: string; refresh_token: string; expires_in: number; scope: string };

describe('renewable MCP connections', () => {
  it('consents to renewal for clients omitting offline_access and refreshes after 24 hours without another login', async () => {
    const provider = new OAuthProvider(oauthOptions), env = oauthEnv();
    const start = await startAuthorization(provider, env, 'ChatGPT-like client', 'crm:read');
    expect(start.response.status).toBe(200);
    expect(start.html).toContain('offline_access');
    expect(start.html).toContain('35 dias');
    const approved = await providerFetch(provider, env, '/authorize', {
      method: 'POST', headers: { Cookie: cookies(start.response) },
      body: new URLSearchParams({ handle: start.handle!, decision: 'approve' }),
    });
    expect(approved.status).toBe(302);
    const upstream = new URL(approved.headers.get('location')!);
    const identity = await simulateAccess(upstream.searchParams.get('nonce')!);
    const callback = await providerFetch(provider, env, '/callback?' + new URLSearchParams({
      code: 'identity-code', state: upstream.searchParams.get('state')!,
    }), { headers: { Cookie: cookies(start.response, approved) } });
    expect(callback.status).toBe(302);
    const code = new URL(callback.headers.get('location')!).searchParams.get('code')!;
    const exchanged = await providerFetch(provider, env, '/token', { method: 'POST', body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: start.client.clientId, code,
      code_verifier: start.verifier, redirect_uri: 'https://client.example/callback', resource: RESOURCE,
    }) });
    expect(exchanged.status).toBe(200);
    const first = await exchanged.json() as Token;
    expect(first.expires_in).toBe(DAY);
    expect(first.refresh_token).toBeTypeOf('string');
    expect(first.scope.split(' ').sort()).toEqual(['crm:read', 'offline_access']);
    const identityCalls = identity.mock.calls.length;

    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + (DAY + 10) * 1000);
    try {
      const expired = await providerFetch(provider, env, '/mcp', {
        headers: { Authorization: `Bearer ${first.access_token}` },
      });
      expect(expired.status).toBe(401);
      expect(expired.headers.get('www-authenticate')).toContain('resource_metadata=');
      const renewed = await providerFetch(provider, env, '/token', { method: 'POST', body: new URLSearchParams({
        grant_type: 'refresh_token', client_id: start.client.clientId,
        refresh_token: first.refresh_token, resource: RESOURCE,
      }) });
      expect(renewed.status).toBe(200);
      const next = await renewed.json() as Token;
      expect(next.expires_in).toBe(DAY);
      expect(next.refresh_token).toBeTypeOf('string');
      expect(next.refresh_token).not.toBe(first.refresh_token);
      expect(next.scope.split(' ').sort()).toEqual(['crm:read', 'offline_access']);
      const tools = await providerFetch(provider, env, '/mcp', {
        method: 'POST', headers: { Host: new URL(RESOURCE).host, Authorization: `Bearer ${next.access_token}`,
          'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(tools.status).toBe(200);
      clock.mockReturnValue(now + (2 * DAY + 20) * 1000);
      const again = await providerFetch(provider, env, '/token', { method: 'POST', body: new URLSearchParams({
        grant_type: 'refresh_token', client_id: start.client.clientId, refresh_token: next.refresh_token,
      }) });
      expect(again.status).toBe(200);
      expect((await again.json() as Token).expires_in).toBe(DAY);
      expect(identity.mock.calls.length).toBe(identityCalls);
    } finally { clock.mockRestore(); identity.mockRestore(); }
  });

  it('issues a 24-hour access token even for a direct grant without offline consent', async () => {
    const token = await issueTestToken(oauthEnv(), undefined, ['crm:read']);
    expect(token).toMatchObject({ expires_in: DAY, scope: 'crm:read' });
    expect(token.refresh_token).toBeUndefined();
  });

  it('does not refresh another client or a grant past its fixed 35-day lifetime', async () => {
    const provider = new OAuthProvider(oauthOptions), env = oauthEnv();
    const first = await issueTestToken(env), other = await issueTestToken(env);
    const body = (clientId: string) => new URLSearchParams({
      grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token!, resource: RESOURCE,
    });
    const mismatch = await providerFetch(provider, env, '/token', { method: 'POST', body: body(other.clientId) });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ error: 'invalid_grant' });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + (35 * DAY + 60) * 1000);
    const expired = await providerFetch(provider, env, '/token', { method: 'POST', body: body(first.clientId) });
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects unsupported product scopes before offering renewal', async () => {
    const start = await startAuthorization(new OAuthProvider(oauthOptions), oauthEnv(), 'Untrusted', 'crm:admin');
    expect(start.response.status).toBe(400);
    expect(start.handle).toBeUndefined();
  });
});
