import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import {
  checkRegistrationQuota,
  recordRegistration,
  registrationQuotaKey,
  validateClientMetadata,
} from '../src/oauth/registration';
import { oauthOptions } from '../src/oauth/provider';
import { readResponseJson } from './helpers/json';
import { oauthEnv, providerFetch } from './oauth-helper';

describe('validateClientMetadata', () => {
  it('accepts valid metadata for public clients', () => {
    expect(
      validateClientMetadata({
        redirect_uris: ['https://client.example/callback'],
        client_name: 'Client',
      }),
    ).toBeUndefined();
  });

  it('rejects software_statement before other invalid metadata', () => {
    expect(validateClientMetadata({ software_statement: 'unverified', redirect_uris: [] })).toEqual({
      code: 'invalid_client_metadata',
      reason: 'software_statement',
    });
  });

  it('rejects serialized metadata larger than 8 KiB', () => {
    expect(validateClientMetadata({ redirect_uris: ['https://client.example/cb'], note: 'é'.repeat(4100) })).toEqual({
      code: 'invalid_client_metadata',
      reason: 'metadata_too_large',
    });
  });

  it('accepts serialized metadata of exactly 8 KiB', () => {
    const metadata: Record<string, unknown> = { redirect_uris: ['https://client.example/cb'], note: '' };
    const emptySize = new TextEncoder().encode(JSON.stringify(metadata)).byteLength;
    metadata.note = 'x'.repeat(8192 - emptySize);
    expect(new TextEncoder().encode(JSON.stringify(metadata)).byteLength).toBe(8192);
    expect(validateClientMetadata(metadata)).toBeUndefined();
  });

  it('accepts five redirect URIs and rejects six', () => {
    const uris = Array.from({ length: 6 }, (_, index) => `https://client.example/${index}`);
    expect(validateClientMetadata({ redirect_uris: uris.slice(0, 5) })).toBeUndefined();
    expect(validateClientMetadata({ redirect_uris: uris })).toEqual({
      code: 'invalid_redirect_uri',
      reason: 'redirect_uri_count',
    });
  });

  it.each([undefined, null, 'https://client.example/cb', [], [1], ['https://client.example/cb', 1]])(
    'rejects invalid redirect_uris collection: %s',
    (redirectUris) => {
      expect(validateClientMetadata({ redirect_uris: redirectUris })).toEqual({
        code: 'invalid_redirect_uri',
        reason: 'redirect_uri_count',
      });
    },
  );

  it('accepts redirect URIs of 512 characters and rejects 513', () => {
    const validUri = `https://client.example/${'a'.repeat(512 - 'https://client.example/'.length)}`;
    expect(validUri).toHaveLength(512);
    expect(validateClientMetadata({ redirect_uris: [validUri] })).toBeUndefined();
    expect(validateClientMetadata({ redirect_uris: [`${validUri}x`] })).toEqual({
      code: 'invalid_redirect_uri',
      reason: 'redirect_uri_invalid',
    });
  });

  it.each([
    'http://127.0.0.1:53682/callback',
    'http://localhost/cb',
    'http://[::1]:8080/cb',
    'https://client.example/callback',
  ])('accepts supported redirect URI %s', (redirectUri) => {
    expect(validateClientMetadata({ redirect_uris: [redirectUri] })).toBeUndefined();
  });

  it.each(['http://example.com/cb', 'javascript:alert(1)', 'custom-scheme://callback', 'not a URL'])(
    'rejects unsupported redirect URI %s',
    (redirectUri) => {
      expect(validateClientMetadata({ redirect_uris: [redirectUri] })).toEqual({
        code: 'invalid_redirect_uri',
        reason: 'redirect_uri_invalid',
      });
    },
  );

  it('accepts client names of 100 characters and rejects 101 or non-strings', () => {
    expect(validateClientMetadata({ redirect_uris: ['https://client.example/cb'], client_name: 'x'.repeat(100) })).toBe(
      undefined,
    );
    expect(
      validateClientMetadata({ redirect_uris: ['https://client.example/cb'], client_name: 'x'.repeat(101) }),
    ).toEqual({ code: 'invalid_client_metadata', reason: 'client_name_invalid' });
    expect(validateClientMetadata({ redirect_uris: ['https://client.example/cb'], client_name: 1 })).toEqual({
      code: 'invalid_client_metadata',
      reason: 'client_name_invalid',
    });
  });
});

describe('dynamic client registration', () => {
  const provider = () => new OAuthProvider(oauthOptions);
  const register = (metadata: Record<string, unknown>) =>
    providerFetch(provider(), oauthEnv(), '/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    });

  it.each([
    {
      label: 'ChatGPT',
      client_name: 'ChatGPT',
      redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    { label: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' },
    { label: 'oauth:login local', redirect_uris: ['http://127.0.0.1:53682/callback'] },
  ])('accepts supported client metadata from $label', async (metadata) => {
    const { label: _label, ...payload } = metadata;
    const response = await register(payload);
    expect(response.status).toBe(201);
    expect((await readResponseJson<{ client_id: string }>(response)).client_id).toBeTruthy();
  });

  it('rejects registration and logs only the event and reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const response = await register({
        client_name: 'Private client name',
        redirect_uris: ['https://client.example/cb'],
        software_statement: 'unverified',
      });
      expect(response.status).toBe(400);
      expect(await readResponseJson<{ error: string }>(response)).toMatchObject({ error: 'invalid_client_metadata' });
      expect(warn).toHaveBeenCalledWith({ event: 'oauth_registration_rejected', reason: 'software_statement' });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('daily dynamic client registration quota', () => {
  const metadata = {
    client_name: 'Quota test client',
    redirect_uris: ['https://client.example/callback'],
  };
  const registerThroughWorker = async (env = oauthEnv()) => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request('https://elo-unit.cloudflareworkers.com/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.10' },
        body: JSON.stringify(metadata),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  };

  it('counts successful registrations and logs only the redirect URI count', async () => {
    const env = oauthEnv();
    const key = registrationQuotaKey(new Date());
    await env.OAUTH_KV.delete(key);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const response = await registerThroughWorker(env);
      expect(response.status).toBe(201);
      expect(await env.OAUTH_KV.get(key)).toBe('1');
      expect(info).toHaveBeenCalledWith({ event: 'oauth_client_registered', redirectUriCount: 1 });
    } finally {
      info.mockRestore();
    }
  });

  it('rejects registrations after the daily quota is exhausted', async () => {
    const env = oauthEnv();
    const key = registrationQuotaKey(new Date());
    await env.OAUTH_KV.put(key, '20');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const response = await registerThroughWorker(env);

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: 'temporarily_unavailable' });
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await env.OAUTH_KV.get(key)).toBe('20');
      expect(warn).toHaveBeenCalledWith({ event: 'oauth_registration_rejected', reason: 'daily_quota' });
    } finally {
      await env.OAUTH_KV.delete(key);
      warn.mockRestore();
    }
  });

  it('fails closed when the daily quota cannot be read', async () => {
    const unavailableKv = {
      get: async (): Promise<null> => {
        throw new Error('KV unavailable');
      },
    } as unknown as KVNamespace;
    const env = oauthEnv({ OAUTH_KV: unavailableKv });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const response = await registerThroughWorker(env);

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: 'temporarily_unavailable' });
      expect(warn).toHaveBeenCalledWith({ event: 'oauth_registration_rejected', reason: 'quota_unavailable' });
    } finally {
      warn.mockRestore();
    }
  });

  it('does not count registrations rejected by metadata validation', async () => {
    const env = oauthEnv();
    const key = registrationQuotaKey(new Date());
    await env.OAUTH_KV.delete(key);
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request('https://elo-unit.cloudflareworkers.com/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.10' },
        body: JSON.stringify({ ...metadata, software_statement: 'unverified' }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
    expect(await env.OAUTH_KV.get(key)).toBeNull();
  });

  it('uses the UTC date for quota keys', () => {
    expect(registrationQuotaKey(new Date('2026-11-23T23:30:00-03:00'))).toBe('register-quota:2026-11-24');
  });

  it('treats an invalid stored quota value as unavailable', async () => {
    const env = oauthEnv();
    const key = registrationQuotaKey(new Date());
    try {
      await env.OAUTH_KV.put(key, '-1');
      expect(await checkRegistrationQuota(env.OAUTH_KV, new Date())).toBe('unavailable');
    } finally {
      await env.OAUTH_KV.delete(key);
    }
  });

  it('uses a two day TTL and does not throw when recording fails', async () => {
    const now = new Date('2026-11-24T12:00:00Z');
    const put = vi.fn().mockRejectedValue(new Error('KV write failed'));
    const kv = { get: async () => '4', put } as unknown as KVNamespace;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(recordRegistration(kv, now, 2)).resolves.toBeUndefined();
      expect(put).toHaveBeenCalledWith('register-quota:2026-11-24', '5', { expirationTtl: 172800 });
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'oauth_registration_quota_write_failed' }));
    } finally {
      warn.mockRestore();
    }
  });
});
