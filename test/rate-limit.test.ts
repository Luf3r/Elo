import { describe, it, expect, vi } from 'vitest';
import { enforceRateLimit, enforceCrmRateLimit } from '../src/rate-limit';
import worker from '../src/index';
import { context, testEnv } from './helpers';
import { issueTestToken } from './oauth-token';
import { RESOURCE } from '../src/oauth/config';

describe('native rate limiting', () => {
  it('allows requests with a stable non-secret client key', async () => {
    const env = testEnv();
    await enforceRateLimit(env, { clientId: 'test', scopes: [] });
    expect(env.MCP_RATE_LIMITER.limit).toHaveBeenCalledWith({ key: 'mcp:test' });
  });
  it('rejects quota exhaustion', async () => {
    const env = testEnv({ MCP_RATE_LIMITER: { limit: vi.fn(async () => ({ success: false })) } });
    await expect(enforceRateLimit(env, { clientId: 'test', scopes: [] })).rejects.toMatchObject({ code: 'MCP_RATE_LIMITED', status: 429 });
    const token = await issueTestToken(env);
    const r = await worker.fetch(new Request(RESOURCE, { headers: { Authorization: `Bearer ${token.access_token}` } }), env, context());
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('10');
  });
  it('authenticates before spending rate limit quota', async () => {
    const env = testEnv();
    expect((await worker.fetch(new Request('https://example.com/mcp'), env, context())).status).toBe(401);
    expect(env.MCP_RATE_LIMITER.limit).not.toHaveBeenCalled();
  });
  it('fails closed if native limiter is absent or unavailable', async () => {
    for (const binding of [undefined, { limit: vi.fn(async () => { throw Error('sensitive binding error'); }) }]) {
      await expect(enforceRateLimit(testEnv({ MCP_RATE_LIMITER: binding as RateLimit }), { clientId: 'test', scopes: [] })).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    }
  });
  it('enforces a separate upstream budget per CRM call', async () => {
    const env = testEnv();
    await enforceCrmRateLimit(env);
    expect(env.AGENDOR_CRM_RATE_LIMITER.limit).toHaveBeenCalledWith({ key: 'agendor-crm:shared' });
    env.AGENDOR_CRM_RATE_LIMITER.limit = vi.fn(async () => ({ success: false }));
    await expect(enforceCrmRateLimit(env)).rejects.toMatchObject({ code: 'UPSTREAM_RATE_LIMITED' });
  });
});
