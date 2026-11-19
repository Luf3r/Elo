import { z } from 'zod';
import type { Env } from '../env';
import { SafeError } from '../shared/errors';
import { throwIfCancelled } from '../shared/cancellation';
import { positiveId } from '../agendor/chat/schemas';
import { createAgendorChatClient } from './clients';
import { accountState } from './state/budget';
import { allowedInboxIds, isInboxAllowed } from '../domain/inbox-policy';
import { payloadDigest } from './operations';
import type { AutomationPolicy, WorkLease } from './types';

export const discoveryTool = 'automation_discover_pending';
export const maxDiscoveryPages = 10;
export const discoveryLookbackMs = 7 * 24 * 60 * 60 * 1000;
export const discoveryCursorMs = 30 * 60 * 1000;
export const discoveryInputSchema = z.strictObject({
  inboxIds: z.array(positiveId).min(1).max(2).optional(),
  cursor: z.uuid().optional(),
});
export type DiscoveryInput = z.infer<typeof discoveryInputSchema>;
export const discoveryCursorSchema = z.strictObject({
  scope: z.string().min(1),
  inboxIndex: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  seen: z.array(z.string()),
  startedAt: z.number().finite(),
});
export type DiscoveryCursor = z.infer<typeof discoveryCursorSchema>;
export const pendingActivitySchema = z.strictObject({
  eventId: z.string().min(1),
  accountId: z.string().min(1),
  conversationId: z.number().int().positive(),
  inboxId: z.number().int().positive(),
  timestamp: z.number().finite(),
  status: z.string().min(1),
  page: z.number().int().positive(),
});
export type PendingActivity = z.infer<typeof pendingActivitySchema>;
type ActivityRow = Awaited<
  ReturnType<ReturnType<typeof createAgendorChatClient>['listScopedActivity']>
>['rows'][number];
export const isPendingRequest = (id: string) => id.startsWith('pending:');

export function discoverySettings(env: Env, policy: AutomationPolicy, requested?: readonly number[]) {
  const authorized = allowedInboxIds.filter((id) => isInboxAllowed(id, policy));
  const inboxes = requested ? [...new Set(requested)].sort((a, b) => a - b) : authorized;
  const reason =
    !inboxes.length || inboxes.some((id) => !authorized.includes(id))
      ? 'INBOX_SCOPE_NOT_AUTHORIZED'
      : policy.mode === 'disabled'
        ? 'AUTOMATION_DISABLED'
        : null;
  return { inboxes, reason };
}

function timestampMs(row: ActivityRow) {
  return row.timestamp === null ? null : row.timestamp >= 1e12 ? row.timestamp : row.timestamp * 1000;
}

export async function discoverPending(
  env: Env,
  actor: WorkLease['owner'],
  input: DiscoveryInput,
  currentPolicy: () => Promise<AutomationPolicy>,
  signal?: AbortSignal,
) {
  const policy = await currentPolicy();
  const { inboxes, reason } = discoverySettings(env, policy, input.inboxIds);
  if (reason) return { state: 'blocked' as const, reason, candidates: [] };
  const repository = accountState(env);
  const accountId = env.AGENDOR_CHAT_ACCOUNT_ID;
  const scope = await payloadDigest({ actor, accountId, inboxes, policyVersion: policy.version });
  const now = Date.now();
  const cursor: DiscoveryCursor | undefined = input.cursor
    ? await repository.getPendingCursor(input.cursor)
    : { scope, inboxIndex: 0, page: 1, seen: [], startedAt: now };
  if (!cursor || cursor.scope !== scope || cursor.startedAt + discoveryCursorMs <= now)
    throw new SafeError('WORK_STALE', 'Discovery cursor is unavailable, expired or outside this scope.', false, 409);
  const inboxId = inboxes[cursor.inboxIndex]!;
  const chat = createAgendorChatClient(env, { signal });
  const inventory = await chat.listInboxInventory();
  if (inventory.length !== allowedInboxIds.length || inventory.some((id, index) => id !== allowedInboxIds[index]))
    throw new SafeError(
      'UPSTREAM_INVALID_RESPONSE',
      'Chat inbox inventory differs from the authorized account scope.',
      false,
    );
  let page;
  try {
    page = await chat.listScopedActivity(inboxId, cursor.page);
  } catch (error) {
    if (error instanceof SafeError && error.retryable)
      return {
        state: 'deferred' as const,
        candidates: [],
        cursor: input.cursor,
        retryAt: new Date(Date.now() + 10_000).toISOString(),
      };
    throw error;
  }
  throwIfCancelled(signal);
  const current = await currentPolicy();
  if (current.version !== policy.version || discoverySettings(env, current, inboxes).reason)
    throw new SafeError('POLICY_BLOCKED', 'Discovery scope changed; start a new scan.', false, 403);
  const signature = await payloadDigest(page.rows.map((row) => row.id).sort((a, b) => a - b));
  const repeated = cursor.seen.includes(signature);
  const entries: PendingActivity[] = [];
  let skipped = 0;
  if (!repeated)
    for (const row of page.rows) {
      const timestamp = timestampMs(row);
      if (timestamp === null || row.status === null || timestamp > cursor.startedAt + 300_000) {
        skipped++;
        continue;
      }
      if (timestamp < cursor.startedAt - discoveryLookbackMs) continue;
      const eventId = 'pending:' + (await payloadDigest([accountId, inboxId, row.id, timestamp, row.status]));
      entries.push({
        eventId,
        accountId,
        inboxId,
        conversationId: row.id,
        timestamp,
        status: row.status,
        page: cursor.page,
      });
    }
  const hasNext = page.pageInfo.hasNext !== false && page.rows.length > 0 && !repeated;
  const pageCap = hasNext && cursor.page >= maxDiscoveryPages;
  const next =
    hasNext && !pageCap
      ? { ...cursor, page: cursor.page + 1, seen: [...cursor.seen, signature] }
      : cursor.inboxIndex + 1 < inboxes.length
        ? { ...cursor, inboxIndex: cursor.inboxIndex + 1, page: 1, seen: [] }
        : undefined;
  const saved = await repository.savePendingPage(entries, policy.version, next);
  return {
    state: saved.cursor ? ('continue' as const) : ('end' as const),
    cursor: saved.cursor,
    inboxId,
    page: cursor.page,
    coverage: {
      complete: false,
      skippedUnverified: skipped,
      reason: repeated
        ? 'page_repeated'
        : pageCap
          ? 'page_limit'
          : page.pageInfo.hasNext === null
            ? 'pagination_unverified'
            : 'live_collection',
    },
    candidates: saved.entries.map((e) => ({
      conversationId: e.conversationId,
      inboxId: e.inboxId,
      activityAt: new Date(e.timestamp).toISOString(),
      status: e.status,
      prepare: {
        requestId: e.eventId,
        target: { kind: 'conversation' as const, conversationId: e.conversationId },
        inboxIds: [e.inboxId],
        mode: 'preview' as const,
        limits: { maxMessagePages: 10, maxAttachmentPages: 1 },
      },
    })),
  };
}

/** An observation authorizes no content. Look it up again through the same scoped
 * route, and require the exact activity before reading contact/messages/CRM. */
export async function verifyPendingActivity(chat: ReturnType<typeof createAgendorChatClient>, event: PendingActivity) {
  const page = await chat.listScopedActivity(event.inboxId, event.page);
  const row = page.rows.find((row) => row.id === event.conversationId && row.inboxId === event.inboxId);
  if (!row || timestampMs(row) !== event.timestamp || row.status !== event.status)
    throw new SafeError('WORK_STALE', 'Conversation moved or changed; restart discovery.', false, 409);
  return row;
}
