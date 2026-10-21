import type { Env } from './env';
import { SafeError } from './errors';
export interface AuthContext { clientId: 'test' }
export function isConfiguredSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/\s/.test(value) && value !== 'replace-me';
}
export async function timingSafeTokenEqual(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}
export async function authenticateClient(request: Request, env: Env): Promise<AuthContext> {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization') ?? '');
  if (!isConfiguredSecret(env.MCP_TEST_TOKEN) || !match?.[1] || !await timingSafeTokenEqual(match[1], env.MCP_TEST_TOKEN)) {
    throw new SafeError('MCP_UNAUTHORIZED', 'Unauthorized.', false, 401);
  }
  return { clientId: 'test' };
}
