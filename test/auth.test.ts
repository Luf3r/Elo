import { describe, expect, it, vi } from 'vitest';
import { authenticateClient, timingSafeTokenEqual } from '../src/auth';
import worker from '../src/index';
import { context, testEnv } from './helpers';

describe('authentication', () => {
  it.each([undefined, 'Basic x', 'Bearer ', 'Bearer x', 'Bearer unit-mcp-tokeX', 'Bearer unit-mcp-token trailing', 'Bearer\tunit-mcp-token'])('rejects %s', async header => {
    const request = new Request('https://example.com/mcp', { headers: header ? { Authorization: header } : {} });
    await expect(authenticateClient(request, testEnv())).rejects.toMatchObject({ code: 'MCP_UNAUTHORIZED', status: 401 });
  });
  it('accepts a valid bearer token', async () => {
    expect(await authenticateClient(new Request('https://example.com/mcp', { headers: { Authorization: 'Bearer unit-mcp-token' } }), testEnv())).toEqual({ clientId: 'test' });
  });
  it('uses SHA-256 fixed length digests and Workers timing-safe comparison', async () => {
    const compare = vi.spyOn(crypto.subtle, 'timingSafeEqual');
    expect(await timingSafeTokenEqual('short', 'a much longer value')).toBe(false);
    expect(await timingSafeTokenEqual('á🚰', 'á🚰')).toBe(true);
    expect(compare).toHaveBeenCalledTimes(2);
    for (const [left, right] of compare.mock.calls) {
      expect(left.byteLength).toBe(32);
      expect(right.byteLength).toBe(32);
    }
  });
  it.each([undefined, '', '  ', 'replace-me', 'bad\nvalue'])('fails closed with missing/invalid MCP secret', async token => {
    const env = testEnv({ MCP_TEST_TOKEN: token as string });
    const r = await worker.fetch(new Request('https://example.com/mcp', { headers: { Authorization: 'Bearer unit-mcp-token' } }), env, context());
    expect(r.status).toBe(401);
  });
  it.each([undefined, '', 'replace-me', 'bad\nvalue'])('fails closed with missing/invalid upstream secret', async token => {
    const r = await worker.fetch(new Request('https://example.com/mcp', { headers: { Authorization: 'Bearer unit-mcp-token' } }), testEnv({ AGENDOR_CRM_TOKEN: token as string }), context());
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain('unit-mcp-token');
  });
});
