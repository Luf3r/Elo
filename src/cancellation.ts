import { SafeError } from './errors';

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SafeError('UPSTREAM_UNAVAILABLE', 'Request cancelled.', false);
}
