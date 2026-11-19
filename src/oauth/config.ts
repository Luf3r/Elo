import { DEPLOYMENT } from '../app/config/deployment';
import type { Env } from '../env';

export const ORIGIN = DEPLOYMENT.origin;
export const RESOURCE = `${ORIGIN}/mcp`;
export const OWNER_EMAIL = DEPLOYMENT.ownerEmail;
export const READ_SCOPE = 'crm:read';
export const CHAT_READ_SCOPE = 'chat:read';
export const WRITE_SCOPE = 'crm:write';
export const CREATE_SCOPE = 'crm:create';
export const ENRICH_SCOPE = 'crm:enrich';
export const AUTOMATION_READ_SCOPE = 'automation:read';
export const AUTOMATION_PROCESS_SCOPE = 'automation:process';
export const AUTOMATION_MANAGE_SCOPE = 'automation:manage';
export const OPTIONAL_SCOPE = 'offline_access';
export const SUPPORTED_SCOPES = [
  READ_SCOPE,
  CHAT_READ_SCOPE,
  WRITE_SCOPE,
  CREATE_SCOPE,
  ENRICH_SCOPE,
  AUTOMATION_READ_SCOPE,
  AUTOMATION_PROCESS_SCOPE,
  AUTOMATION_MANAGE_SCOPE,
  OPTIONAL_SCOPE,
] as const;
export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  issuer: string;
  authorizationUrl: string;
  tokenUrl: string;
  jwksUrl: string;
}

export function readOAuthConfig(env: Env): OAuthConfig {
  const clientId = env.ACCESS_CLIENT_ID;
  if (
    !clientId ||
    !/^[a-zA-Z0-9_-]{1,200}$/.test(clientId) ||
    !env.ACCESS_CLIENT_SECRET ||
    /\s/.test(env.ACCESS_CLIENT_SECRET)
  )
    throw new Error('OAuth is not configured.');
  const url = (value: string | undefined): URL => {
    if (!value) throw new Error('OAuth is not configured.');
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(parsed.hostname) ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      parsed.search
    )
      throw new Error('Invalid identity provider configuration.');
    return parsed;
  };
  const issuer = url(env.ACCESS_ISSUER);
  const endpoint = (value: string | undefined, name: string): string => {
    const parsed = url(value);
    if (parsed.origin !== issuer.origin || parsed.pathname !== `/cdn-cgi/access/sso/oidc/${clientId}/${name}`)
      throw new Error('Invalid identity provider endpoint.');
    return parsed.href;
  };
  return {
    clientId,
    clientSecret: env.ACCESS_CLIENT_SECRET,
    issuer: env.ACCESS_ISSUER,
    authorizationUrl: endpoint(env.ACCESS_AUTHORIZATION_URL, 'authorization'),
    tokenUrl: endpoint(env.ACCESS_TOKEN_URL, 'token'),
    jwksUrl: endpoint(env.ACCESS_JWKS_URL, 'jwks'),
  };
}
