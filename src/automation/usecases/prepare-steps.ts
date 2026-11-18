import { z } from 'zod';
import type { AgendorCrmClient, PagedResult } from '../../agendor/crm/types';
import { candidateLookupLinks, readCustomerCandidates, readDuplicateCandidates } from '../../domain/identity';
import { SafeError } from '../../shared/errors';
import { readJson } from '../../shared/json';
import { createAgendorChatClient, createConversationReader, readCanonicalConversation } from '../clients';
import type { PendingActivity } from '../discovery';
import type { WorkflowState } from '../service-state';
import type { PrepareResult } from '../types';
import { createReview, persistWorkflow, type WorkflowContext } from './context';
import type { authorizePreparation } from './policy';

export function preparationProgress(state: WorkflowState) {
  return {
    stage:
      state.step === 0
        ? ('conversation' as const)
        : state.step === 1
          ? ('candidates' as const)
          : state.catalog
            ? ('hydration' as const)
            : ('catalog' as const),
    messagePages: state.conversations.reduce((sum, c) => sum + (c.coverage.history?.pagesRead ?? 0), 0),
    messages: state.conversations.reduce((sum, c) => sum + c.messages.length, 0),
    attachmentPages: state.conversations.reduce((sum, c) => sum + (c.attachmentListing?.pagesRead ?? 0), 0),
    catalogPages: state.pages.length,
    candidateLookups: Object.keys(state.candidateReadCache ?? {}).length,
    hydrated: state.hydration?.offset ?? 0,
  };
}

export function blockedPreparation(state: WorkflowState): PrepareResult {
  return {
    state: 'blocked',
    workId: state.lease.workId,
    reason: 'PREPARATION_NO_PROGRESS',
    lastReason: state.preparationDeferral?.reason ?? 'UPSTREAM_UNAVAILABLE',
    progress: preparationProgress(state),
    leaseExpiresAt: state.lease.expiresAt,
    recovery: 'Reinicie a preparação com o mesmo requestId após a expiração do lease e verifique a auditoria.',
  };
}

export async function deferPreparation(
  ctx: WorkflowContext,
  state: WorkflowState,
  reason: string,
  retryAfterSeconds = 10,
): Promise<PrepareResult> {
  const snapshot = preparationProgress(state);
  const checkpoint = JSON.stringify(snapshot);
  const attempts = state.preparationDeferral?.checkpoint === checkpoint ? state.preparationDeferral.attempts + 1 : 1;
  const nextRetryAt = new Date(Date.now() + Math.max(1, retryAfterSeconds) * 1000).toISOString();
  state.preparationDeferral = { checkpoint, attempts, reason, blocked: attempts >= 5, nextRetryAt };
  await persistWorkflow(ctx.repository, state);
  if (state.preparationDeferral.blocked) return blockedPreparation(state);
  return {
    state: 'deferred',
    workId: state.lease.workId,
    retryAt: nextRetryAt,
    leaseToken: state.lease.leaseToken,
    continuation: state.continuation,
    reason,
    progress: snapshot,
    noProgressAttempts: attempts,
  };
}

export async function readConversationsStep(
  ctx: WorkflowContext,
  state: WorkflowState,
  evidence: Array<Awaited<ReturnType<ReturnType<typeof createAgendorChatClient>['getConversation']>>>,
  chat: ReturnType<typeof createAgendorChatClient>,
  settings: ReturnType<typeof authorizePreparation>,
  pending: PendingActivity | undefined,
  validateScope: () => Promise<void>,
): Promise<PrepareResult | undefined> {
  for (const detail of evidence) {
    const conversationId = detail.id;
    const previous = state.conversations.find((c) => c.conversationId === conversationId);
    if (previous && !previous.continuation && !previous.attachmentListing?.nextPage) continue;
    const save = async (snapshot: import('../../agendor/chat/types').ConversationSnapshot) => {
      const index = state.conversations.findIndex((c) => c.conversationId === conversationId);
      if (index < 0) state.conversations.push(snapshot);
      else state.conversations[index] = snapshot;
      await persistWorkflow(ctx.repository, state);
    };
    const reader = createConversationReader({
      getConversation: (id) =>
        readCanonicalConversation(
          {
            getConversation: async () => detail,
            getContact: async (contactId) => {
              await validateScope();
              return chat.getContact(contactId);
            },
          },
          id,
          { allowedInboxIds: settings.inboxIds },
        ),
      listAttachments: (id, options) => chat.listAttachments(id, { ...options, beforePage: validateScope }),
      listMessages: async (id, options) => {
        await validateScope();
        return chat.listMessages(id, options);
      },
    });
    const snapshot = await reader.readConversation(
      { conversationId },
      {
        previous,
        onProgress: save,
        maxMessagePages: settings.limits.maxMessagePages,
        maxAttachmentPages: settings.limits.maxAttachmentPages,
      },
    );
    const invalidHistory = snapshot.coverage.missingReasons.filter((reason) =>
      [
        'conversation_mismatch',
        'message_cursor_invalid',
        'cursor_repeated',
        'cursor_invalid',
        'history_query_failed',
      ].includes(reason),
    );
    if (invalidHistory.length)
      return {
        state: 'review',
        workId: state.lease.workId,
        reviewIds: [await createReview(ctx, state, invalidHistory)],
      };
    if (snapshot.continuation || snapshot.attachmentListing?.nextPage) {
      if (snapshot.continuation && snapshot.messages.length >= 10000)
        return {
          state: 'review',
          workId: state.lease.workId,
          reviewIds: [await createReview(ctx, state, snapshot.coverage.missingReasons)],
        };
      return await deferPreparation(ctx, state, 'MORE_PAGES');
    }
  }
  await validateScope();
  if (state.range)
    for (const conversation of state.conversations) {
      const range = state.range;
      if (conversation.messages.some((m) => m.createdAt === undefined)) {
        conversation.coverage.complete = false;
        conversation.coverage.missingReasons.push('message_time_unverified');
      }
      conversation.messages = conversation.messages.filter((m) => {
        if (m.createdAt === undefined) return false;
        const time = m.createdAt > 1e12 ? m.createdAt : m.createdAt * 1000;
        return time >= Date.parse(range.from) && time <= Date.parse(range.to);
      });
    }
  state.step++;
  await persistWorkflow(ctx.repository, state);
  if (!pending)
    for (const conversationId of state.conversationIds) await ctx.repository.acknowledgeChatHints(conversationId);
  return undefined;
}

export async function resolveCandidatesStep(
  ctx: WorkflowContext,
  state: WorkflowState,
  crm: AgendorCrmClient,
  validateScope: () => Promise<void>,
): Promise<void> {
  await validateScope();
  const contact = state.conversations[0]?.contact;
  // Cache successful reads in server-owned work state before requesting another
  // page, so a shared-budget deferral cannot restart the same search forever.
  const remembered = async <T>(key: string, schema: z.ZodType<T>, load: () => Promise<T>): Promise<T> => {
    await validateScope();
    state.candidateReadCache ??= {};
    const cached = state.candidateReadCache[key];
    if (cached !== undefined) return readJson(schema, cached, 'candidateReadCache');
    const value = await load();
    const json = JSON.stringify(value);
    if (Object.values(state.candidateReadCache).reduce((n, v) => n + v.length, 0) + json.length > 500_000)
      throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Candidate read cache exceeded the work limit.', false);
    state.candidateReadCache[key] = json;
    await persistWorkflow(ctx.repository, state);
    return value;
  };
  const pagedResultSchema: z.ZodType<PagedResult<unknown>> = z.object({
    items: z.array(z.unknown()),
    pageInfo: z.object({
      page: z.number(),
      perPage: z.number(),
      hasNext: z.boolean(),
      nextPage: z.number().nullable(),
    }),
  });
  const candidatesCrm = {
    getPerson: (id: number) => remembered('person:' + id, z.unknown(), () => crm.getPerson(id)),
    searchPeople: (input: Parameters<typeof crm.searchPeople>[0]) =>
      remembered('people:' + JSON.stringify(input), pagedResultSchema, () => crm.searchPeople(input)),
    searchOrganizations: (input: Parameters<typeof crm.searchOrganizations>[0]) =>
      remembered('organizations:' + JSON.stringify(input), pagedResultSchema, () => crm.searchOrganizations(input)),
  };
  state.candidates = contact
    ? await readCustomerCandidates(candidatesCrm, contact, state.conversations[0]!.revision)
    : { candidates: [], coverage: { complete: false, missingReasons: ['contact_unavailable'], pagesRead: 0 } };
  if (state.candidates.crmContactLink?.status === 'verified') {
    const person = state.candidates.candidates.find(
      (c) => c.ref.kind === 'person' && c.ref.id === state.candidates.crmContactLink!.crmPersonId,
    );
    if (person) state.candidates.duplicateCheck = await readDuplicateCandidates(candidatesCrm, person);
  }
  if (state.lease.target.kind === 'conversation') {
    const linked = await ctx.repository.findLinkedCustomer(candidateLookupLinks(state.candidates));
    if (linked.customerId) state.customerId = linked.customerId;
    if (linked.ambiguous) {
      state.candidates.coverage.complete = false;
      state.candidates.coverage.missingReasons.push('customer_binding_ambiguous');
    }
  }
  state.candidates.customerId = state.customerId;
  state.step++;
  await persistWorkflow(ctx.repository, state);
}
