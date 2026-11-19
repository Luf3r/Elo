import { expect, vi } from 'vitest';
import { createExecutionContext, env as runtimeEnv, runInDurableObject } from 'cloudflare:test';
import type { AutomationAccount } from '../src/automation/state/account';
import type { BudgetTicket } from '../src/automation/types';
import type { Env } from '../src/env';

const budgetMocks = new WeakMap<Env['AUTOMATION_STATE'], ReturnType<typeof makeBudgetMock>>();
const NON_RPC_STUB_KEYS = new Set<string | symbol>(['id', 'name', 'fetch', 'connect', 'then']);

function invokeInDurableObject<T>(
  stub: DurableObjectStub<AutomationAccount>,
  method: string | symbol,
  args: unknown[],
): Promise<T> {
  return runInDurableObject(stub, (instance) => {
    const fn = Reflect.get(instance, method) as (...callArgs: unknown[]) => T | Promise<T>;
    return fn.apply(instance, args);
  });
}

function makeBudgetMock(stub: ReturnType<Env['AUTOMATION_STATE']['get']>) {
  return vi.fn((product: 'crm' | 'chat', now: number): Promise<BudgetTicket> =>
    invokeInDurableObject(stub, 'takeBudget', [product, now]),
  );
}
export const context = () => createExecutionContext();
export function testEnv(overrides: Partial<Env> = {}): Env {
  const namespace = (runtimeEnv as Env).AUTOMATION_STATE;
  const realStub = namespace.get(namespace.newUniqueId());
  const takeBudget = makeBudgetMock(realStub);
  // Route RPC method calls through runInDurableObject so expected domain
  // rejections inside the DO do not log "uncaught exception" across the RPC boundary.
  const stub = new Proxy(realStub, {
    get(target, prop) {
      if (prop === 'takeBudget') return takeBudget;
      const value: unknown = Reflect.get(target, prop);
      if (NON_RPC_STUB_KEYS.has(prop) || typeof prop === 'symbol' || typeof value !== 'function') {
        if (typeof value !== 'function') return value;
        const bound: unknown = value.bind(target);
        return bound;
      }
      return (...args: unknown[]) => invokeInDurableObject(realStub, prop, args);
    },
  });
  const bindings: Env = {
    AUTOMATION_QUEUE: (runtimeEnv as Env).AUTOMATION_QUEUE,
    AUTOMATION_STATE: new Proxy(namespace, {
      get(target, prop) {
        if (prop === 'getByName') return () => stub;
        const value: unknown = Reflect.get(target, prop);
        if (typeof value !== 'function') return value;
        const bound: unknown = value.bind(target);
        return bound;
      },
    }),
    AGENDOR_CRM_TOKEN: 'unit-crm-token',
    AGENDOR_CHAT_ACCOUNT_ID: '',
    OAUTH_KV: (runtimeEnv as { OAUTH_KV: KVNamespace }).OAUTH_KV,
    OAUTH_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    ACCESS_CLIENT_ID: 'unit-client',
    ACCESS_CLIENT_SECRET: 'unit-secret',
    ACCESS_ISSUER: 'https://elo-unit.cloudflareaccess.com',
    ACCESS_AUTHORIZATION_URL: 'https://elo-unit.cloudflareaccess.com/cdn-cgi/access/sso/oidc/unit-client/authorization',
    ACCESS_TOKEN_URL: 'https://elo-unit.cloudflareaccess.com/cdn-cgi/access/sso/oidc/unit-client/token',
    ACCESS_JWKS_URL: 'https://elo-unit.cloudflareaccess.com/cdn-cgi/access/sso/oidc/unit-client/jwks',
    MCP_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    ...overrides,
  };
  budgetMocks.set(bindings.AUTOMATION_STATE, takeBudget);
  return bindings;
}

export function budgetMock(env: Env) {
  const mock = budgetMocks.get(env.AUTOMATION_STATE);
  if (!mock) throw Error('Use testEnv');
  return mock;
}
export const allowBudget = async () => {};
export const expandedCrmToolNames = [
  'crm_create_organization',
  'crm_create_person',
  'crm_create_deal',
  'crm_create_task',
  'crm_enrich_organization',
  'crm_enrich_person',
  'crm_enrich_deal',
  'crm_update_task',
];

/**
 * Catch expected Durable Object domain errors inside `runInDurableObject` so
 * `@cloudflare/vitest-plugin` 1.4.6 does not log rejected RPC promises as
 * unhandled (`uncaught exception`) when crossing the isolate boundary.
 */
export async function durableFailure(
  stub: DurableObjectStub<AutomationAccount>,
  operation: (instance: AutomationAccount) => Promise<unknown>,
  expectedMessage = '',
): Promise<{ message: string; code?: string; retryable?: boolean }> {
  const result = await runInDurableObject(stub, async (instance) => {
    try {
      await operation(instance);
      return { failed: false as const, message: '' };
    } catch (error) {
      const record = error as { code?: unknown; retryable?: unknown };
      return {
        failed: true as const,
        message: error instanceof Error ? error.message : String(error),
        ...(typeof record.code === 'string' ? { code: record.code } : {}),
        ...(typeof record.retryable === 'boolean' ? { retryable: record.retryable } : {}),
      };
    }
  });
  expect(result.failed).toBe(true);
  if (!result.failed) throw Error('Expected Durable Object failure.');
  if (expectedMessage) expect(result.message).toContain(expectedMessage);
  return {
    message: result.message,
    ...(result.code !== undefined ? { code: result.code } : {}),
    ...(result.retryable !== undefined ? { retryable: result.retryable } : {}),
  };
}
