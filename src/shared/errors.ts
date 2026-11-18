export type ErrorCode =
  | 'INVALID_INPUT'
  | 'MCP_UNAUTHORIZED'
  | 'MCP_RATE_LIMITED'
  | 'UPSTREAM_UNAUTHORIZED'
  | 'UPSTREAM_FORBIDDEN'
  | 'UPSTREAM_NOT_FOUND'
  | 'UPSTREAM_RATE_LIMITED'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_INVALID_RESPONSE'
  | 'UPSTREAM_CONFLICT'
  | 'UPSTREAM_REJECTED'
  | 'CHAT_API_NOT_CONFIGURED'
  | 'CONTEXT_STALE';

export class SafeError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly requiredScope?: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'SafeError';
  }
}

export class BudgetDeferredError extends SafeError {
  constructor(retryAt?: number) {
    super(
      'UPSTREAM_RATE_LIMITED',
      'Shared request budget reached. Retry later.',
      true,
      429,
      undefined,
      retryAt === undefined ? undefined : Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)),
    );
  }
}

export function safeError(error: unknown): SafeError {
  return error instanceof SafeError
    ? error
    : new SafeError('UPSTREAM_UNAVAILABLE', 'Service temporarily unavailable.', true, 503);
}

export function errorData(error: unknown) {
  const safe = safeError(error);
  return {
    code: safe.code,
    message: safe.message,
    retryable: safe.retryable,
    ...(safe.status === undefined ? {} : { status: safe.status }),
    ...(safe.requiredScope === undefined ? {} : { requiredScope: safe.requiredScope }),
  };
}
