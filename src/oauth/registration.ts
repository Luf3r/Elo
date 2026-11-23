import { errorFields, logEvent } from '../shared/logger';

export type RegistrationRejectionReason =
  | 'software_statement'
  | 'metadata_too_large'
  | 'redirect_uri_count'
  | 'redirect_uri_invalid'
  | 'client_name_invalid'
  | 'daily_quota'
  | 'quota_unavailable';

export const REGISTRATION_DAILY_LIMIT = 20;
const REGISTRATION_QUOTA_TTL_SECONDS = 172800;

export function registrationQuotaKey(now: Date): string {
  return `register-quota:${now.toISOString().slice(0, 10)}`;
}

function parseQuota(value: string | null): number | undefined {
  if (value === null) return 0;
  if (!/^\d+$/.test(value)) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : undefined;
}

/**
 * The KV read and write are not atomic, so this limit is approximate. It bounds the worst case to
 * about 20 × 8 KiB × 90 days ≈ 14 MiB in OAUTH_KV.
 */
export async function checkRegistrationQuota(kv: KVNamespace, now: Date): Promise<'ok' | 'exhausted' | 'unavailable'> {
  try {
    const count = parseQuota(await kv.get(registrationQuotaKey(now)));
    if (count === undefined) return 'unavailable';
    return count >= REGISTRATION_DAILY_LIMIT ? 'exhausted' : 'ok';
  } catch {
    return 'unavailable';
  }
}

export async function recordRegistration(kv: KVNamespace, now: Date, redirectUriCount: number): Promise<void> {
  try {
    const key = registrationQuotaKey(now);
    const current = parseQuota(await kv.get(key));
    if (current === undefined) throw new Error('Invalid registration quota value.');
    await kv.put(key, String(current + 1), { expirationTtl: REGISTRATION_QUOTA_TTL_SECONDS });
    logEvent('info', 'oauth_client_registered', { redirectUriCount });
  } catch (error) {
    logEvent('warn', 'oauth_registration_quota_write_failed', errorFields(error));
  }
}

const MAX_METADATA_BYTES = 8192;
const MAX_REDIRECT_URI_LENGTH = 512;
const MAX_CLIENT_NAME_LENGTH = 100;

function invalidRedirectUri(uri: string): boolean {
  if (uri.length > MAX_REDIRECT_URI_LENGTH) return true;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return true;
  }
  if (parsed.protocol === 'https:') return false;
  return parsed.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
}

export function validateClientMetadata(
  metadata: Record<string, unknown>,
): { code: 'invalid_redirect_uri' | 'invalid_client_metadata'; reason: RegistrationRejectionReason } | undefined {
  if (Object.hasOwn(metadata, 'software_statement')) {
    return { code: 'invalid_client_metadata', reason: 'software_statement' };
  }
  if (new TextEncoder().encode(JSON.stringify(metadata)).byteLength > MAX_METADATA_BYTES) {
    return { code: 'invalid_client_metadata', reason: 'metadata_too_large' };
  }
  const redirectUris = metadata.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length < 1 ||
    redirectUris.length > 5 ||
    !redirectUris.every((uri) => typeof uri === 'string')
  ) {
    return { code: 'invalid_redirect_uri', reason: 'redirect_uri_count' };
  }
  if (redirectUris.some((uri) => invalidRedirectUri(uri))) {
    return { code: 'invalid_redirect_uri', reason: 'redirect_uri_invalid' };
  }
  if (
    Object.hasOwn(metadata, 'client_name') &&
    (typeof metadata.client_name !== 'string' || metadata.client_name.length > MAX_CLIENT_NAME_LENGTH)
  ) {
    return { code: 'invalid_client_metadata', reason: 'client_name_invalid' };
  }
  return undefined;
}

export const clientRegistrationCallback = ({ clientMetadata }: { clientMetadata: Record<string, unknown> }) => {
  const rejection = validateClientMetadata(clientMetadata);
  if (!rejection) return undefined;
  logEvent('warn', 'oauth_registration_rejected', { reason: rejection.reason });
  return { code: rejection.code, description: 'Client registration rejected.', status: 400 };
};
