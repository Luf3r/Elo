import { vi } from 'vitest';
import { createExecutionContext } from 'cloudflare:test';
import type { Env } from '../src/env';

export const context = () => createExecutionContext();
export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    AGENDOR_CRM_TOKEN: 'unit-crm-token',
    MCP_TEST_TOKEN: 'unit-mcp-token',
    MCP_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    AGENDOR_CRM_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    ...overrides,
  };
}
