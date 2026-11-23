import { describe, expect, it, vi } from 'vitest';
import { rpc, callTool } from './mcp-helper';
import { readToolJson, type InitializeResult, type ToolListResult } from './helpers/json';
import packageJson from '../package.json';
import { COMMIT } from '../src/version';
import { testEnv } from './helpers';

describe('Streamable HTTP MCP', () => {
  it.each([
    ['without CRM or Chat', { AGENDOR_CRM_TOKEN: '', AGENDOR_CHAT_TOKEN: '', AGENDOR_CHAT_ACCOUNT_ID: '' }, 1],
    ['with CRM only', { AGENDOR_CRM_TOKEN: 'unit-crm-token', AGENDOR_CHAT_TOKEN: '', AGENDOR_CHAT_ACCOUNT_ID: '' }, 23],
    [
      'with Chat only',
      { AGENDOR_CRM_TOKEN: '', AGENDOR_CHAT_TOKEN: 'unit-chat-token', AGENDOR_CHAT_ACCOUNT_ID: '7001' },
      9,
    ],
    [
      'with CRM and Chat',
      { AGENDOR_CRM_TOKEN: 'unit-crm-token', AGENDOR_CHAT_TOKEN: 'unit-chat-token', AGENDOR_CHAT_ACCOUNT_ID: '7001' },
      44,
    ],
  ] as const)('lists the configured tool set %s', async (_description, overrides, count) => {
    const { data, response } = await rpc<ToolListResult>('tools/list', {}, testEnv(overrides));
    expect(response.status).toBe(200);
    expect(data.result?.tools).toHaveLength(count);
  });

  it('rejects unauthenticated protocol calls', async () => {
    const { response } = await rpc('tools/list', {}, undefined, { Authorization: 'Bearer invalid' });
    expect(response.status).toBe(401);
  });
  it('negotiates initialization', async () => {
    const { data, response } = await rpc<InitializeResult>('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'elo-test', version: '1.0' },
    });
    expect(response.status).toBe(200);
    expect(data.result?.serverInfo).toMatchObject({ name: 'elo-agendor-mcp', version: packageJson.version });
  });
  it('lists separately scoped CRM readers and updates without a generic HTTP surface', async () => {
    const { data, response } = await rpc<ToolListResult>('tools/list');
    expect(response.status).toBe(200);
    const tools = data.result?.tools ?? [];
    expect(tools.map((t) => t.name)).toContain('server_status');
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/delete|send|upsert|archive|move|request|fetch/);
      if (
        tool.name.startsWith('crm_create_') ||
        tool.name.startsWith('crm_enrich_') ||
        tool.name === 'crm_update_task'
      ) {
        expect(tool.annotations?.readOnlyHint).toBe(false);
        expect(tool._meta?.securitySchemes).toEqual([
          { type: 'oauth2', scopes: [tool.name.startsWith('crm_create_') ? 'crm:create' : 'crm:enrich'] },
        ]);
      } else if (tool.name.startsWith('crm_update_')) {
        expect(tool.description).not.toContain('Read-only');
        expect(tool.annotations?.readOnlyHint).toBe(false);
        expect(tool._meta?.securitySchemes).toEqual([{ type: 'oauth2', scopes: ['crm:write'] }]);
      } else {
        expect(tool.description).toContain('Read-only');
        expect(tool.annotations?.readOnlyHint).toBe(true);
        expect(tool._meta?.securitySchemes).toEqual([
          { type: 'oauth2', scopes: tool.name === 'server_status' ? [] : ['crm:read'] },
        ]);
      }
    }
  });
  it('calls server_status without upstream access', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const { data } = await callTool('server_status');
    expect(data.result?.isError).not.toBe(true);
    expect(readToolJson<Record<string, unknown>>(data)).toMatchObject({
      status: 'ok',
      service: 'elo-agendor-mcp',
      version: packageJson.version,
      commit: COMMIT,
      client: expect.any(String) as string,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps overlapping requests isolated', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => callTool('server_status')));
    for (const { data, response } of results) {
      expect(response.status).toBe(200);
      expect(readToolJson<{ status: string }>(data).status).toBe('ok');
    }
  });
});
