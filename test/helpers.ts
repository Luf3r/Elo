import { vi } from 'vitest';
import { createExecutionContext, env as runtimeEnv } from 'cloudflare:test';
import type { Env } from '../src/env';

export const context = () => createExecutionContext();
export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    AGENDOR_CRM_TOKEN: 'unit-crm-token',
    MCP_TEST_TOKEN: 'unit-mcp-token',
    OAUTH_KV: (runtimeEnv as {OAUTH_KV:KVNamespace}).OAUTH_KV,
    OAUTH_RATE_LIMITER: {limit:vi.fn(async()=>({success:true}))},
    ACCESS_CLIENT_ID:'unit-client', ACCESS_CLIENT_SECRET:'unit-secret',
    ACCESS_ISSUER:'https://elo-unit.cloudflareaccess.com',
    ACCESS_AUTHORIZATION_URL:'https://elo-unit.cloudflareaccess.com/cdn-cgi/access/sso/oidc/unit-client/authorization',
    ACCESS_TOKEN_URL:'https://elo-unit.cloudflareaccess.com/cdn-cgi/access/sso/oidc/unit-client/token',
    ACCESS_JWKS_URL:'https://elo-unit.cloudflareaccess.com/cdn-cgi/access/sso/oidc/unit-client/jwks',
    MCP_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    AGENDOR_CRM_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    ...overrides,
  };
}
