import { SafeError } from './errors';
import type { OAuthResourceAuth } from '@cloudflare/workers-oauth-provider';
import { OWNER_EMAIL, RESOURCE } from './oauth/config';
export interface AuthContext { clientId: string; userId?: string; scopes: readonly string[] }
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
export function authenticateClient(ctx: ExecutionContext): AuthContext {
  const auth = (ctx as ExecutionContext & { auth?: OAuthResourceAuth }).auth;
  const props: unknown = ctx.props;
  if (!auth?.clientId || !auth.userId || auth.audience !== RESOURCE ||
    !props || typeof props !== 'object' || !('email' in props) || props.email !== OWNER_EMAIL ||
    !('userId' in props) || props.userId !== auth.userId ||
    (auth.expiresAt !== undefined && auth.expiresAt <= Date.now()/1000)) {
    throw new SafeError('MCP_UNAUTHORIZED', 'Unauthorized.', false, 401);
  }
  const scopes = Array.isArray(auth.scope) ? auth.scope : [];
  return { clientId: auth.clientId, userId: auth.userId, scopes };
}

export function requireScope(auth: AuthContext, scope: string): void {
  if (!auth.scopes.includes(scope)) throw new SafeError('MCP_UNAUTHORIZED', 'Insufficient scope.', false, 403, scope);
}
