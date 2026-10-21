import { SafeError } from './errors';
import { throwIfCancelled } from './cancellation';

export interface UpstreamRequestOptions { timeoutMs?: number }
export async function fetchJson<T>(request: Request, options: UpstreamRequestOptions = {}): Promise<T> {
  throwIfCancelled(request.signal);
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetch(new Request(request, { signal, redirect: 'manual' }));
    if (!response.ok) {
      const statuses: Record<number, [import('./errors').ErrorCode, string, boolean]> = {
        401: ['UPSTREAM_UNAUTHORIZED', 'Upstream authentication failed.', false],
        403: ['UPSTREAM_FORBIDDEN', 'Upstream access denied.', false],
        404: ['UPSTREAM_NOT_FOUND', 'Record not found.', false],
        429: ['UPSTREAM_RATE_LIMITED', 'Upstream rate limit reached. Retry later.', true],
      };
      const [code, message, retryable] = statuses[response.status] ?? (response.status >= 500
        ? ['UPSTREAM_UNAVAILABLE', 'Upstream service temporarily unavailable.', true]
        : ['UPSTREAM_INVALID_RESPONSE', 'Unexpected upstream response.', false]);
      await response.body?.cancel();
      throw new SafeError(code, message, retryable, response.status);
    }
    try { return await response.json() as T; }
    catch {
      throwIfCancelled(request.signal);
      if (controller.signal.aborted) throw new SafeError('UPSTREAM_TIMEOUT', 'Upstream request timed out.', true);
      throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Upstream returned invalid JSON.', false, response.status);
    }
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throwIfCancelled(request.signal);
    if (controller.signal.aborted) throw new SafeError('UPSTREAM_TIMEOUT', 'Upstream request timed out.', true);
    throw new SafeError('UPSTREAM_UNAVAILABLE', 'Upstream service temporarily unavailable.', true);
  } finally { clearTimeout(timer); }
}
