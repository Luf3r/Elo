import { SafeError } from './shared/errors';
import type { OAuthResourceAuth } from '@cloudflare/workers-oauth-provider';
import { OWNER_EMAIL, RESOURCE, SUPPORTED_SCOPES } from './oauth/config';
export interface AuthContext {
  clientId: string;
  userId?: string;
  scopes: readonly string[];
  expiresAt?: number;
}
export function authenticateClient(ctx: ExecutionContext): AuthContext {
  const auth = (ctx as ExecutionContext & { auth?: OAuthResourceAuth }).auth;
  const props: unknown = ctx.props;
  // The provider supplies epoch seconds; all downstream authorization uses milliseconds.
  const expiresAt = auth?.expiresAt === undefined ? undefined : auth.expiresAt * 1000;
  if (
    !auth?.clientId ||
    !auth.userId ||
    auth.audience !== RESOURCE ||
    !props ||
    typeof props !== 'object' ||
    !('email' in props) ||
    props.email !== OWNER_EMAIL ||
    !('userId' in props) ||
    props.userId !== auth.userId ||
    (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now()))
  ) {
    throw new SafeError('MCP_UNAUTHORIZED', 'Unauthorized.', false, 401);
  }
  // Grants outside this deployment's supported scopes (for example write scopes on a
  // read-only staging deployment) are dropped, so tools that need them fail closed.
  const scopes = (Array.isArray(auth.scope) ? auth.scope : []).filter((scope) => SUPPORTED_SCOPES.includes(scope));
  return { clientId: auth.clientId, userId: auth.userId, scopes, ...(expiresAt === undefined ? {} : { expiresAt }) };
}

export function requireScope(auth: AuthContext, scope: string): void {
  if (!auth.scopes.includes(scope)) throw new SafeError('MCP_UNAUTHORIZED', 'Insufficient scope.', false, 403, scope);
}

export function requireCapabilities(auth: AuthContext, capabilities: readonly string[]): void {
  if (auth.expiresAt !== undefined && (!Number.isFinite(auth.expiresAt) || auth.expiresAt <= Date.now())) {
    throw new SafeError('MCP_UNAUTHORIZED', 'Authorization expired.', false, 401);
  }
  for (const capability of capabilities) requireScope(auth, capability);
}
