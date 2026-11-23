import { describe, expect, it } from 'vitest';
import { authenticateClient } from '../src/auth';
import worker from '../src/index';
import { context, testEnv } from './helpers';
import { RESOURCE } from '../src/oauth/config';
import { callTool } from './mcp-helper';
import { readToolJson, type ToolErrorBody } from './helpers/json';

describe('OAuth authentication', () => {
  it.each([
    undefined,
    'Basic x',
    'Bearer ',
    'Bearer x',
    'Bearer static-token',
    'Bearer static-token trailing',
    'Bearer\tstatic-token',
  ])('rejects %s', async (header) => {
    const r = await worker.fetch(
      new Request(RESOURCE, { headers: header ? { Authorization: header } : {} }),
      testEnv(),
      context(),
    );
    expect(r.status).toBe(401);
  });
  it('rejects a forged context or mismatched subject even after token validation', () => {
    const ctx = context();
    expect(() => authenticateClient(ctx)).toThrow();
    Object.assign(ctx, {
      props: { email: 'owner@elo.example', userId: 'other' },
      auth: { clientId: 'client', userId: 'owner', audience: RESOURCE, scope: ['crm:read'] },
    });
    expect(() => authenticateClient(ctx)).toThrow();
  });
  it.each([undefined, '', 'replace-me', 'bad\nvalue'])(
    'keeps MCP available when CRM is unconfigured while failing CRM tools locally',
    async (token) => {
      const env = testEnv({ AGENDOR_CRM_TOKEN: token as string });
      const { response, data } = await callTool('crm_get_deal', { id: 1 }, env);
      expect(response.status).toBe(200);
      expect(data.result?.isError).toBe(true);
      expect(readToolJson<ToolErrorBody>(data).error.code).toBe('UPSTREAM_UNAVAILABLE');
    },
  );
});
