import { testEnv, budgetMock } from './helpers';
import { readToolJson, type ToolErrorBody } from './helpers/json';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeWrite } from '../src/mcp/tools/read';
import type { AuthContext } from '../src/auth';

afterEach(() => vi.unstubAllGlobals());
const auth = (scopes: string[]): AuthContext => ({ clientId: 'client-1', scopes });
function env() {
  return testEnv();
}

describe('CRM write authorization boundary', () => {
  it('requires crm:write before consuming the CRM request budget or calling Agendor', async () => {
    const bindings = env();
    const fetch = vi.spyOn(globalThis, 'fetch');
    const result = await executeWrite(bindings, auth(['crm:read']), (client) =>
      client.updateDeal(42, { title: 'Test' }),
    );
    expect(result.isError).toBe(true);
    expect(readToolJson<ToolErrorBody>(result).error.code).toBe('MCP_UNAUTHORIZED');
    expect(readToolJson<ToolErrorBody>(result).error.requiredScope).toBe('crm:write');
    expect(result._meta).toEqual({
      'mcp/www_authenticate': ['Bearer error="insufficient_scope", scope="crm:write"'],
    });
    expect(budgetMock(bindings)).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not let crm:read authorize writes', async () => {
    const bindings = env();
    const fetch = vi.spyOn(globalThis, 'fetch');
    const result = await executeWrite(bindings, auth(['crm:read']), (client) =>
      client.updateDeal(42, { title: 'Test' }),
    );
    expect(result.isError).toBe(true);
    expect(budgetMock(bindings)).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the shared CRM rate budget for an authorized update', async () => {
    const bindings = env();
    const fetch = vi.fn(async () => Response.json({ data: { id: 42 } }));
    vi.stubGlobal('fetch', fetch);
    const result = await executeWrite(bindings, auth(['crm:write']), (client) =>
      client.updateDeal(42, { title: 'Test' }),
    );
    expect(result.isError).toBeUndefined();
    expect(budgetMock(bindings)).toHaveBeenCalledWith('crm', expect.any(Number));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
