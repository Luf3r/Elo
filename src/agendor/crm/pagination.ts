import type { PagedResult } from './types';
import { listEnvelope } from './schemas';
import { SafeError } from '../../shared/errors';

export function normalizePage<T>(upstream: unknown, currentPage: number, perPage: number): PagedResult<T> {
  const result = listEnvelope.safeParse(upstream);
  if (!result.success) throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Invalid upstream collection.', false);
  const next = result.data.links?.next;
  let nextPage: number | null = null;
  if (next) {
    try {
      const url = new URL(next);
      const raw = url.searchParams.get('page') ?? '';
      const page = Number(raw);
      if (
        url.origin === 'https://api.agendor.com.br' &&
        url.pathname.startsWith('/v3/') &&
        /^\d+$/.test(raw) &&
        Number.isSafeInteger(page) &&
        page > currentPage
      )
        nextPage = page;
    } catch {
      /* Preserve hasNext without guessing a page or following a URL. */
    }
  }
  return {
    items: (result.data.data ?? result.data.items ?? []) as T[],
    pageInfo: { page: currentPage, perPage, hasNext: Boolean(next), nextPage },
  };
}
