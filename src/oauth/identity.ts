import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { OWNER_EMAIL, type OAuthConfig } from './config';

export interface OwnerIdentity { userId: string; email: string }

export async function verifyAccessIdentity(token: string, nonce: string, config: OAuthConfig): Promise<OwnerIdentity> {
  if (!token || token.length > 16_384 || !nonce) throw new Error('Invalid identity.');
  const keys = createRemoteJWKSet(new URL(config.jwksUrl), {
    timeoutDuration: 10_000,
    [customFetch]: async (url, options) => fetch(url, { ...options, redirect: 'error' }),
  });
  const { payload } = await jwtVerify(token, keys, {
    issuer: config.issuer, audience: config.clientId, algorithms: ['RS256'],
    requiredClaims: ['sub', 'email', 'nonce', 'iat', 'exp'], maxTokenAge: '10m', clockTolerance: 5,
  });
  if (payload.nonce !== nonce || payload.email !== OWNER_EMAIL || !payload.sub ||
    (payload.azp !== undefined && payload.azp !== config.clientId) ||
    (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId)) throw new Error('Identity is not authorized.');
  return { userId: payload.sub, email: OWNER_EMAIL };
}
