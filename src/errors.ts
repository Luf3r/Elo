export type ErrorCode =
  | 'INVALID_INPUT' | 'MCP_UNAUTHORIZED' | 'MCP_RATE_LIMITED'
  | 'UPSTREAM_UNAUTHORIZED' | 'UPSTREAM_FORBIDDEN' | 'UPSTREAM_NOT_FOUND'
  | 'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_TIMEOUT' | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_INVALID_RESPONSE' | 'CHAT_API_NOT_CONFIGURED';

export class SafeError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly requiredScope?: string,
  ) { super(message); this.name = 'SafeError'; }
}

export function safeError(error: unknown): SafeError {
  return error instanceof SafeError ? error
    : new SafeError('UPSTREAM_UNAVAILABLE', 'Service temporarily unavailable.', true, 503);
}

export function errorData(error: unknown) {
  const safe = safeError(error);
  return { code: safe.code, message: safe.message, retryable: safe.retryable, ...(safe.status === undefined ? {} : { status: safe.status }), ...(safe.requiredScope === undefined ? {} : { requiredScope: safe.requiredScope }) };
}
