import { describe, expect, it, vi } from 'vitest';
import { rpc, callTool } from './mcp-helper';

describe('Streamable HTTP MCP', () => {
  it('rejects unauthenticated protocol calls', async () => {
    const { response } = await rpc('tools/list', {}, undefined, { Authorization: 'Bearer invalid' });
    expect(response.status).toBe(401);
  });
  it('negotiates initialization', async () => {
    const { data, response } = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'elo-test', version: '1.0' } });
    expect(response.status).toBe(200);
    expect(data.result.serverInfo).toMatchObject({ name: 'elo-agendor-mcp', version: '0.1.0' });
  });
  it('lists read-only tools without a generic or write surface', async () => {
    const { data, response } = await rpc('tools/list');
    expect(response.status).toBe(200);
    expect(data.result.tools.map((t: { name: string }) => t.name)).toContain('server_status');
    for (const tool of data.result.tools) {
      expect(tool.name).not.toMatch(/create|update|delete|send|upsert|archive|move|request|fetch/);
      expect(tool.description).toContain('Read-only');
      expect(tool.annotations.readOnlyHint).toBe(true);
    }
  });
  it('calls server_status without upstream access', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const { data } = await callTool('server_status');
    expect(data.result.isError).not.toBe(true);
    expect(JSON.parse(data.result.content[0].text)).toEqual({ status: 'ok', service: 'elo-agendor-mcp', version: '0.1.0', client: 'test' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps overlapping requests isolated', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => callTool('server_status')));
    for (const { data, response } of results) {
      expect(response.status).toBe(200);
      expect(JSON.parse(data.result.content[0].text).status).toBe('ok');
    }
  });
});
