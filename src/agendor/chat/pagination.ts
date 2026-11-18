import { record } from './schemas';
/** Only explicit next links for this fixed collection are interpreted. Counts alone
 * cannot establish pagination, or the total restricted to authorized inboxes. */
export function collectionPageInfo(raw: unknown, page: number, path: string) {
  const root = record(raw);
  const data = record(root?.data);
  const links = record(root?.links) ?? record(data?.links);
  const unavailable = {
    page,
    nextPage: null as number | null,
    hasNext: null as boolean | null,
    endReached: false,
    complete: false,
  };
  if (!links || !Object.hasOwn(links, 'next')) return unavailable;
  if (links.next === null) return { ...unavailable, hasNext: false, endReached: true, complete: page === 1 };
  if (typeof links.next !== 'string') return unavailable;
  try {
    const url = new URL(links.next, 'https://chat.agendor.com.br/api/v1' + path);
    if (
      url.origin !== 'https://chat.agendor.com.br' ||
      url.pathname !== '/api/v1' + path ||
      url.username ||
      url.password ||
      url.hash
    )
      return unavailable;
    const next = Number(url.searchParams.get('page'));
    if (!Number.isSafeInteger(next) || next !== page + 1) return unavailable;
    return { ...unavailable, nextPage: next, hasNext: true };
  } catch {
    return unavailable;
  }
}
import type { Coverage } from './types';
import { SafeError } from '../../shared/errors';
type PageInfo = ReturnType<typeof collectionPageInfo>;
/** Bounded automatic traversal. The caller can resume nextPage without replaying
 * successful pages when the shared budget or the MCP output bounds a batch. */
export async function readConversationBatch<
  T extends { conversations: Array<{ id: number }>; coverage: Coverage; pageInfo: PageInfo },
>(
  load: (page?: number) => Promise<T>,
  start = 1,
  options: { probeMissingPagination?: boolean; maxPages?: number } = {},
): Promise<T> {
  const maxPages = options.maxPages ?? 3;
  let result: T | undefined;
  const values = new Map<number, T['conversations'][number]>();
  const fingerprints = new Set<string>();
  let page = start,
    pagesRead = 0;
  const reasons = new Set<string>();
  let probing = false;
  let probeNextPage: number | null = null;
  let emptyPage: number | undefined;
  let probeStoppedBy: NonNullable<Coverage['paginationProbe']>['stoppedBy'] | undefined;
  for (let batch = 0; batch < maxPages; batch++) {
    let current: T;
    try {
      current = await load(batch === 0 && start === 1 ? undefined : page);
    } catch (error) {
      if (!result || (error instanceof SafeError && error.code === 'MCP_UNAUTHORIZED')) throw error;
      if (error instanceof SafeError && error.retryable) {
        reasons.add('conversation_read_deferred');
        if (probing) {
          probeNextPage = page;
          probeStoppedBy = 'read_deferred';
        }
      } else {
        reasons.add('conversation_query_failed');
        if (probing) {
          probeNextPage = page;
          probeStoppedBy = 'read_error';
        }
      }
      break;
    }
    pagesRead++;
    const fingerprint = JSON.stringify(current.conversations.map((c) => c.id));
    if (current.conversations.length && fingerprints.has(fingerprint)) {
      reasons.add('conversation_page_repeated');
      if (probing) {
        probeNextPage = null;
        probeStoppedBy = 'page_repeated';
      }
      break;
    }
    fingerprints.add(fingerprint);
    current.conversations.forEach((c) => values.set(c.id, c));
    result = current;
    if (current.pageInfo.endReached || current.pageInfo.hasNext === false) {
      if (probing) probeStoppedBy = 'explicit_end';
      break;
    }
    if (current.pageInfo.hasNext === true) {
      if (current.pageInfo.nextPage !== page + 1) {
        reasons.add('conversation_cursor_invalid');
        if (probing) {
          probeNextPage = null;
          probeStoppedBy = 'page_repeated';
        }
        break;
      }
      page = current.pageInfo.nextPage;
      continue;
    }
    if (!options.probeMissingPagination || current.pageInfo.hasNext !== null) break;
    probing = true;
    if (current.conversations.length === 0) emptyPage ??= page;
    page = current.pageInfo.page + 1;
    probeNextPage = page;
    if (batch === maxPages - 1) probeStoppedBy = 'page_limit';
  }
  if (!result) throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Conversation discovery returned no page.', false);
  const complete = start === 1 && result.pageInfo.endReached && reasons.size === 0;
  if (!complete) reasons.add('conversation_pagination_incomplete');
  return {
    ...result,
    conversations: [...values.values()],
    coverage: {
      complete,
      pagesRead,
      conversationDiscovery: complete ? 'complete' : 'partial',
      missingReasons: [...reasons],
      conversationsRead: values.size,
      ...(probing
        ? {
            paginationProbe: {
              pagesScanned: pagesRead,
              nextPage: probeNextPage,
              ...(emptyPage !== undefined ? { emptyPage } : {}),
              stoppedBy: probeStoppedBy ?? 'page_limit',
            },
          }
        : {}),
    },
  };
}
