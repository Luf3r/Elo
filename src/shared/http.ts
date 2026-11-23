import { SafeError } from './errors';
import { throwIfCancelled } from './cancellation';
import { readBoundedBody } from './bounded-body';

export interface UpstreamRequestOptions {
  timeoutMs?: number;
  request?: (request: Request) => Promise<Response>;
}
const MAX_RESPONSE_BYTES = 1_048_576;
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve original AbortSignal.reason (typed as any in DOM/Workers libs).
      reject(signal.reason);
    };
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}
function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)
      ? Math.ceil((Date.parse(value) - Date.now()) / 1000)
      : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 86_400) : undefined;
}
export async function fetchJson(request: Request, options: UpstreamRequestOptions = {}): Promise<unknown> {
  throwIfCancelled(request.signal);
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await untilAborted(
      (options.request ?? fetch)(new Request(request, { signal, redirect: 'manual' })),
      signal,
    );
    if (!response.ok) {
      const statuses: Record<number, [import('./errors').ErrorCode, string, boolean]> = {
        400: ['UPSTREAM_REJECTED', 'Upstream rejected the input.', false],
        401: ['UPSTREAM_UNAUTHORIZED', 'Upstream authentication failed.', false],
        403: ['UPSTREAM_FORBIDDEN', 'Upstream access denied.', false],
        404: ['UPSTREAM_NOT_FOUND', 'Record not found.', false],
        408: ['UPSTREAM_TIMEOUT', 'Upstream request timed out.', true],
        409: ['UPSTREAM_CONFLICT', 'Upstream record conflict.', false],
        422: ['UPSTREAM_REJECTED', 'Upstream rejected the input.', false],
        429: ['UPSTREAM_RATE_LIMITED', 'Upstream rate limit reached. Retry later.', true],
      };
      const [code, message, retryable] =
        statuses[response.status] ??
        (response.status >= 500
          ? ['UPSTREAM_UNAVAILABLE', 'Upstream service temporarily unavailable.', true]
          : ['UPSTREAM_INVALID_RESPONSE', 'Unexpected upstream response.', false]);
      // Never decode or reflect error bodies, even if cancellation stalls.
      void response.body?.cancel().catch(() => {});
      throw new SafeError(
        code,
        message,
        retryable,
        response.status,
        undefined,
        response.status === 429 ? retryAfterSeconds(response.headers.get('retry-after')) : undefined,
      );
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      void response.body?.cancel().catch(() => {});
      throw new SafeError(
        'UPSTREAM_INVALID_RESPONSE',
        'Upstream response exceeded the size limit.',
        false,
        response.status,
      );
    }
    if (!response.body)
      throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Upstream returned an empty response.', false, response.status);
    const result = await readBoundedBody(response.body, MAX_RESPONSE_BYTES, {
      race: (promise) => untilAborted(promise, signal),
      signal,
    });
    if (result.kind === 'non_binary')
      throw new SafeError(
        'UPSTREAM_INVALID_RESPONSE',
        'Upstream returned a non-binary response chunk.',
        false,
        response.status,
      );
    if (result.kind === 'too_large')
      throw new SafeError(
        'UPSTREAM_INVALID_RESPONSE',
        'Upstream response exceeded the size limit.',
        false,
        response.status,
      );
    try {
      const parsed: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(result.bytes),
      );
      return parsed;
    } catch {
      throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Upstream returned invalid JSON.', false, response.status);
    }
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throwIfCancelled(request.signal);
    if (controller.signal.aborted) throw new SafeError('UPSTREAM_TIMEOUT', 'Upstream request timed out.', true);
    throw new SafeError('UPSTREAM_UNAVAILABLE', 'Upstream service temporarily unavailable.', true);
  } finally {
    clearTimeout(timer);
  }
}
