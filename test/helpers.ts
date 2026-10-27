import { vi } from 'vitest';
import { createExecutionContext, env as runtimeEnv } from 'cloudflare:test';
import type { BudgetTicket } from '../src/automation/types';
import type { Env } from '../src/env';

const budgetMocks = new WeakMap<Env['AUTOMATION_STATE'], ReturnType<typeof makeBudgetMock>>();
function makeBudgetMock(stub: ReturnType<Env['AUTOMATION_STATE']['get']>) { return vi.fn((product: 'crm' | 'chat', now: number): Promise<BudgetTicket> => stub.takeBudget(product, now)); }
export const context = () => createExecutionContext();
export function testEnv(overrides: Partial<Env> = {}): Env {
  const namespace = (runtimeEnv as Env).AUTOMATION_STATE;
  const realStub = namespace.get(namespace.newUniqueId());
  const takeBudget = makeBudgetMock(realStub);
  const stub = new Proxy(realStub, { get(target, prop) { if (prop === 'takeBudget') return takeBudget; return Reflect.get(target, prop); } });
  const bindings: Env = {
    AUTOMATION_QUEUE: (runtimeEnv as Env).AUTOMATION_QUEUE,
    AUTOMATION_STATE: new Proxy(namespace, { get(target, prop) { if (prop === 'getByName') return () => stub; const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value; } }),
    AGENDOR_CRM_TOKEN: 'unit-crm-token',
    AGENDOR_CHAT_ACCOUNT_ID: '',
    MCP_TEST_TOKEN: 'unit-mcp-token',
    OAUTH_KV: (runtimeEnv as {OAUTH_KV:KVNamespace}).OAUTH_KV,
    OAUTH_RATE_LIMITER: {limit:vi.fn(async()=>({success:true}))},
    ACCESS_CLIENT_ID:'unit-client', ACCESS_CLIENT_SECRET:'unit-secret',
    ACCESS_ISSUER:'https://elo-unit.cloudflareaccess.com',
    ACCESS_AUTHORIZATION_URL:'https://elo-unit.cloudflareaccess.com/cdn-cgi/access/sso/oidc/unit-client/authorization',
    ACCESS_TOKEN_URL:'https://elo-unit.cloudflareaccess.com/cdn-cgi/access/sso/oidc/unit-client/token',
    ACCESS_JWKS_URL:'https://elo-unit.cloudflareaccess.com/cdn-cgi/access/sso/oidc/unit-client/jwks',
    MCP_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    ...overrides,
  };
  budgetMocks.set(bindings.AUTOMATION_STATE, takeBudget);
  return bindings;
}

export function budgetMock(env: Env) { const mock = budgetMocks.get(env.AUTOMATION_STATE); if (!mock) throw Error('Use testEnv'); return mock; }
export const allowBudget = async () => {};
