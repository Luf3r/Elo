import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeWrite } from '../src/mcp/tools/read';
import type { Env } from '../src/env';
import type { AuthContext } from '../src/auth';

afterEach(() => vi.unstubAllGlobals());
const auth = (scopes: string[]): AuthContext => ({ clientId: 'client-1', scopes });
function env() {
  return { AGENDOR_CRM_TOKEN: 'test-token', AGENDOR_CRM_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) } } as unknown as Env;
}

describe('CRM write authorization boundary', () => {
  it('requires crm:write before consuming the CRM request budget or calling Agendor', async () => {
    const bindings = env();
    const fetch = vi.spyOn(globalThis, 'fetch');
    const result = await executeWrite(bindings, auth(['crm:read']), client => client.updateDeal(42, { title: 'Test' }));
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).error.code).toBe('MCP_UNAUTHORIZED');
    expect(JSON.parse(result.content[0]!.text).error.requiredScope).toBe('crm:write');
    expect(result._meta).toEqual({ 'mcp/www_authenticate': ['Bearer error=\"insufficient_scope\", scope=\"crm:write\"'] });
    expect(bindings.AGENDOR_CRM_RATE_LIMITER.limit).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not let crm:read authorize writes', async () => {
    const bindings = env();
    const fetch = vi.spyOn(globalThis, 'fetch');
    const result = await executeWrite(bindings, auth(['crm:read']), client => client.updateDeal(42, { title: 'Test' }));
    expect(result.isError).toBe(true);
    expect(bindings.AGENDOR_CRM_RATE_LIMITER.limit).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the shared CRM rate budget for an authorized update', async () => {
    const bindings = env();
    const fetch = vi.fn(async () => Response.json({ data: { id: 42 } }));
    vi.stubGlobal('fetch', fetch);
    const result = await executeWrite(bindings, auth(['crm:write']), client => client.updateDeal(42, { title: 'Test' }));
    expect(result.isError).toBeUndefined();
    expect(bindings.AGENDOR_CRM_RATE_LIMITER.limit).toHaveBeenCalledWith({ key: 'agendor-crm:shared' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
