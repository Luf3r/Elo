export const OFFLINE_REFRESH_TOKEN_TTL_SECONDS = 35 * 24 * 60 * 60;

export function refreshTokenTtlForScopes(scopes: readonly string[]): number {
  return scopes.includes('offline_access') ? OFFLINE_REFRESH_TOKEN_TTL_SECONDS : 0;
}
