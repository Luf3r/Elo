import { logEvent } from '../shared/logger';

export type RegistrationRejectionReason =
  'software_statement' | 'metadata_too_large' | 'redirect_uri_count' | 'redirect_uri_invalid' | 'client_name_invalid';

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
