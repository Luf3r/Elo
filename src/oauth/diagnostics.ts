const AUTHORIZATION_ERROR_CODES = new Set([
  'invalid_request', 'unauthorized_client', 'access_denied', 'unsupported_response_type',
  'invalid_scope', 'server_error', 'temporarily_unavailable',
]);

type OAuthPhase = 'authorization_request' | 'consent_description' | 'consent_creation';

function field(error: unknown, key: string): unknown {
  return typeof error === 'object' && error !== null && key in error
    ? (error as Record<string, unknown>)[key]
    : undefined;
}

export function oauthFailureDiagnostic(phase: OAuthPhase, error: unknown): Record<string, string | number> {
  const name = field(error, 'name');
  const errorType = typeof name === 'string' && /^[A-Za-z]+Error$/.test(name) ? name : 'Error';

  if (errorType === 'AuthorizationError') {
    const code = field(error, 'code');
    return { phase, errorType, ...(typeof code === 'string' && AUTHORIZATION_ERROR_CODES.has(code) ? { code } : {}) };
  }

  if (errorType === 'CimdFetchError') {
    const detail = field(error, 'detail');
    const text = typeof detail === 'string' ? detail : '';
    const status = /^Failed to fetch client metadata: HTTP ([1-5][0-9]{2})$/.exec(text)?.[1];
    const failure = /Client metadata fetch timed out after [0-9]+ms$/.test(text)
      ? 'timeout'
      : status ? 'upstream_http_error' : 'metadata_resolution_failed';
    return { phase: 'client_metadata_resolution', errorType, failure, ...(status ? { upstreamStatus: Number(status) } : {}) };
  }

  return { phase, errorType };
}