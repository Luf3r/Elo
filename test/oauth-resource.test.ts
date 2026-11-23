import { budgetMock, context } from './helpers';
import { readResponseJson, readToolJson, type ToolErrorBody } from './helpers/json';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { ORIGIN, RESOURCE } from '../src/oauth/config';
import { oauthProvider } from '../src/oauth/provider';
import { oauthEnv } from './oauth-helper';
import { issueTestToken } from './oauth-token';
import { callTool } from './mcp-helper';

describe('OAuth resource integration', () => {
  it('does not issue refresh tokens without consent to offline_access', async () => {
    const token = await issueTestToken(oauthEnv(), undefined, ['crm:read']);
    expect(token.refresh_token).toBeUndefined();
  });
  it('publishes discovery for the exact MCP resource and PKCE', async () => {
    const env = oauthEnv();
    const response = await worker.fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource`), env, context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resource: RESOURCE, authorization_servers: [ORIGIN] });
    const auth = await worker.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), env, context());
    expect(await auth.json()).toMatchObject({
      issuer: ORIGIN,
      code_challenge_methods_supported: ['S256'],
      token_endpoint: `${ORIGIN}/token`,
      registration_endpoint: `${ORIGIN}/register`,
      client_id_metadata_document_supported: false,
      scopes_supported: [
        'crm:read',
        'chat:read',
        'crm:write',
        'crm:create',
        'crm:enrich',
        'automation:read',
        'automation:process',
        'automation:manage',
        'offline_access',
      ],
    });
  });
  it('rejects static bearer tokens on /mcp with a discovery challenge', async () => {
    for (const method of ['GET', 'POST']) {
      const r = await worker.fetch(
        new Request(RESOURCE, { method, headers: { Authorization: 'Bearer static-token' } }),
        oauthEnv(),
        context(),
      );
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toContain('resource_metadata=');
    }
  });
  it('refuses token issuance for an unauthorized stored identity', async () => {
    await expect(issueTestToken(oauthEnv(), { userId: 'owner-sub', email: 'other@example.com' })).rejects.toThrow(
      'Identity is not authorized.',
    );
  });
  it('allows a Chat-only token to reach MCP without granting CRM scope', async () => {
    const env = oauthEnv(),
      token = await issueTestToken(env, undefined, ['chat:read']);
    const r = await worker.fetch(
      new Request(RESOURCE, {
        method: 'POST',
        headers: {
          Host: new URL(ORIGIN).host,
          Authorization: `Bearer ${token.access_token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'scope-test', version: '1' } },
        }),
      }),
      env,
      context(),
    );
    expect(r.status).toBe(200);
  });
  it('does not let a Chat-only token call CRM readers', async () => {
    const env = oauthEnv(),
      fetch = vi.spyOn(globalThis, 'fetch');
    const { data, response } = await callTool('crm_search_deals', {}, env, ['chat:read']);
    expect(response.status).toBe(200);
    expect(data.result?.isError).toBe(true);
    expect(readToolJson<ToolErrorBody>(data).error.code).toBe('MCP_UNAUTHORIZED');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not silently expand an empty scope grant to CRM access', async () => {
    const env = oauthEnv(),
      fetch = vi.spyOn(globalThis, 'fetch');
    const { data, response } = await callTool('crm_search_deals', {}, env, []);
    expect(response.status).toBe(200);
    expect(data.result?.isError).toBe(true);
    expect(readToolJson<ToolErrorBody>(data).error.code).toBe('MCP_UNAUTHORIZED');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['OAUTH_KV', 'OAUTH_RATE_LIMITER', 'REGISTER_RATE_LIMITER', 'ACCESS_CLIENT_SECRET'] as const)(
    'fails closed without %s',
    async (key) => {
      const env = oauthEnv({ [key]: undefined });
      const r = await worker.fetch(
        new Request(RESOURCE, { headers: { Authorization: 'Bearer static-token' } }),
        env,
        context(),
      );
      expect(r.status).toBe(503);
    },
  );
  it('keeps separate client grants through refresh and revocation', async () => {
    const env = oauthEnv(),
      first = await issueTestToken(env),
      second = await issueTestToken(env);
    const refreshed = await worker.fetch(
      new Request(`${ORIGIN}/token`, {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '198.51.100.10' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: first.clientId,
          refresh_token: first.refresh_token!,
          resource: RESOURCE,
        }),
      }),
      env,
      context(),
    );
    expect(refreshed.status).toBe(200);
    const next = await readResponseJson<{ access_token: string }>(refreshed);
    const discovery = await worker.fetch(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
      env,
      context(),
    );
    const metadata = await readResponseJson<{ revocation_endpoint: string }>(discovery);
    const revoked = await worker.fetch(
      new Request(metadata.revocation_endpoint, {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '198.51.100.10' },
        body: new URLSearchParams({ client_id: first.clientId, token: next.access_token }),
      }),
      env,
      context(),
    );
    expect(revoked.status).toBe(200);
    expect(
      (
        await worker.fetch(
          new Request(RESOURCE, { headers: { Authorization: `Bearer ${next.access_token}` } }),
          env,
          context(),
        )
      ).status,
    ).toBe(401);
    const other = await worker.fetch(
      new Request(RESOURCE, {
        method: 'POST',
        headers: {
          Host: new URL(ORIGIN).host,
          Authorization: `Bearer ${second.access_token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
      env,
      context(),
    );
    expect(other.status).toBe(200);
  });
  it('fails closed when OAuth quota is exhausted and does not consume CRM budget', async () => {
    const env = oauthEnv({ OAUTH_RATE_LIMITER: { limit: vi.fn(async () => ({ success: false })) } });
    const r = await worker.fetch(
      new Request(`${ORIGIN}/register`, {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '198.51.100.10' },
        body: '{}',
      }),
      env,
      context(),
    );
    expect(r.status).toBe(429);
    expect(budgetMock(env)).not.toHaveBeenCalled();
  });
  it('applies the registration limiter only to POST /register', async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const env = oauthEnv({ REGISTER_RATE_LIMITER: { limit } });
    for (const [path, method] of [
      ['/register', 'POST'],
      ['/token', 'POST'],
      ['/authorize', 'GET'],
    ]) {
      await worker.fetch(
        new Request(`${ORIGIN}${path}`, { method, headers: { 'CF-Connecting-IP': '198.51.100.10' } }),
        env,
        context(),
      );
    }
    expect(limit).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledWith({ key: 'register:198.51.100.10' });
  });
  it('rejects the fourth registration from one IP before reaching the OAuth provider', async () => {
    let attempts = 0;
    const limit = vi.fn(async () => ({ success: ++attempts <= 3 }));
    const env = oauthEnv({ REGISTER_RATE_LIMITER: { limit } });
    const providerFetch = vi.spyOn(oauthProvider, 'fetch');
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const response = await worker.fetch(
          new Request(`${ORIGIN}/register`, {
            method: 'POST',
            headers: { 'CF-Connecting-IP': '198.51.100.10' },
            body: '{}',
          }),
          env,
          context(),
        );
        if (attempt === 3) {
          expect(response.status).toBe(429);
          expect(response.headers.get('retry-after')).toBe('10');
          expect(response.headers.get('cache-control')).toBe('no-store');
          expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
        }
      }
      expect(providerFetch).toHaveBeenCalledTimes(3);
    } finally {
      providerFetch.mockRestore();
    }
  });
  it('does not call the registration limiter when the OAuth limiter rejects', async () => {
    const registerLimit = vi.fn(async () => ({ success: true }));
    const env = oauthEnv({
      OAUTH_RATE_LIMITER: { limit: vi.fn(async () => ({ success: false })) },
      REGISTER_RATE_LIMITER: { limit: registerLimit },
    });
    const response = await worker.fetch(
      new Request(`${ORIGIN}/register`, {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '198.51.100.10' },
        body: '{}',
      }),
      env,
      context(),
    );
    expect(response.status).toBe(429);
    expect(registerLimit).not.toHaveBeenCalled();
  });
  it.each([undefined, '   '])(
    'rejects OAuth route requests without CF-Connecting-IP (%s) with 429',
    async (headerValue) => {
      const limit = vi.fn(async () => ({ success: true }));
      const env = oauthEnv({ OAUTH_RATE_LIMITER: { limit } });
      const headers = headerValue !== undefined ? { 'CF-Connecting-IP': headerValue } : undefined;
      const r = await worker.fetch(
        new Request(`${ORIGIN}/register`, { method: 'POST', headers, body: '{}' }),
        env,
        context(),
      );
      expect(r.status).toBe(429);
      expect(r.headers.get('retry-after')).toBe('10');
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(await r.json()).toEqual({ error: 'temporarily_unavailable' });
      expect(limit).not.toHaveBeenCalled();
    },
  );
});
