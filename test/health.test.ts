import { describe, it, expect, vi } from 'vitest';
import worker from '../src/index';
import { testEnv, context } from './helpers';

describe('routing and health', () => {
  it('returns public JSON health without calling upstream or exposing secrets', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const response = await worker.fetch(new Request('https://example.com/health'), testEnv(), context());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ status: 'ok', service: 'elo-agendor-mcp', version: '0.1.0' });
    expect(text).not.toContain('unit-crm-token');
    expect(text).not.toContain('unit-mcp-token');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['/unknown', '/mcp/extra', '/'])('rejects unknown path %s', async path => {
    expect((await worker.fetch(new Request(`https://example.com${path}`, { method: 'POST' }), testEnv(), context())).status).toBe(404);
  });
});
