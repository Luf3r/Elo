import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../src/index';
import type { Env } from '../src/env';
import { testEnv, context } from './helpers';
import packageJson from '../package.json';
import { COMMIT } from '../src/version';

describe('routing and health', () => {
  it('loads synthetic bindings from test/wrangler.jsonc without reading root .dev.vars', () => {
    const runtime = env as Env & { RUN_AGENDOR_CONTRACT_TESTS?: string };
    expect(runtime.AGENDOR_CRM_TOKEN).toBe('unit-crm-token');
    expect(runtime.AGENDOR_CHAT_TOKEN).toBe('');
    expect(runtime.AGENDOR_CHAT_ACCOUNT_ID).toBe('');
    expect(runtime.ACCESS_CLIENT_ID).toBe('unit-client');
    expect(runtime.ACCESS_CLIENT_SECRET).toBe('unit-secret');
    expect(runtime.RUN_AGENDOR_CONTRACT_TESTS).toBe('0');
  });
  it('returns public JSON health without calling upstream or exposing secrets', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const response = await worker.fetch(new Request('https://example.com/health'), testEnv(), context());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      status: 'ok',
      service: 'elo-agendor-mcp',
      version: packageJson.version,
      commit: COMMIT,
    });
    expect(COMMIT).toBe('unknown');
    expect(text).not.toContain('unit-crm-token');
    expect(text).not.toContain('unit-secret');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['/unknown', '/mcp/extra', '/'])('rejects unknown path %s', async (path) => {
    expect(
      (await worker.fetch(new Request(`https://example.com${path}`, { method: 'POST' }), testEnv(), context())).status,
    ).toBe(404);
  });
  it('returns 404 for removed /automation/chat-events endpoint', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/automation/chat-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'event-1', accountId: '7001', conversationId: 101 }),
      }),
      testEnv(),
      context(),
    );
    expect(response.status).toBe(404);
  });
});
