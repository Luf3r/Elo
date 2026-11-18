import { parseInput } from '../../agendor/crm/schemas';
import { requireAutomationOperation } from '../../domain/authorization';
import { throwIfCancelled } from '../../shared/cancellation';
import { SafeError } from '../../shared/errors';
import { createAgendorChatClient, createAgendorCrmClient } from '../clients';
import { discoverySettings, isPendingRequest, verifyPendingActivity } from '../discovery';
import { payloadDigest } from '../operations';
import { prepareInputSchema } from '../schemas';
import type { WorkflowState } from '../service-state';
import type { PrepareInput, PrepareResult } from '../types';
import {
  automationActor,
  createReview,
  loadPendingActivity,
  loadWorkflow,
  owns,
  persistWorkflow,
  readWorkflow,
  unavailable,
  type WorkflowContext,
} from './context';
import { authorizePreparation, enforceInboxPolicy, type PreparationRequest } from './policy';
import {
  blockedPreparation,
  deferPreparation,
  preparationProgress,
  readConversationsStep,
  resolveCandidatesStep,
} from './prepare-steps';
import { finalizePreparedSnapshot, readCatalogAndHydrateStep } from './prepare-hydration';

export async function prepareWork(
  ctx: WorkflowContext,
  raw: PrepareInput,
  range?: WorkflowState['range'],
): Promise<PrepareResult> {
  const caller = automationActor(ctx.auth);
  const input = parseInput(prepareInputSchema, raw);
  throwIfCancelled(ctx.signal);
  if ('target' in input) {
    authorizePreparation(await ctx.policy(), input);
    if (isPendingRequest(input.requestId) && (await loadPendingActivity(ctx, input.requestId, input)).planId)
      return { state: 'empty' };
  }
  let state: WorkflowState;
  if ('workId' in input) {
    state = await loadWorkflow(ctx, input.workId);
    if (
      state.lease.leaseToken !== input.leaseToken ||
      state.continuation !== input.continuation ||
      (state.discoveryId && state.discoveryId !== input.requestId)
    )
      unavailable('Invalid work continuation.');
  } else {
    const { inboxIds, limits, ...request } = input;
    const lease = await ctx.repository.reserveWork({
      ...request,
      actor: caller,
      payloadDigest: await payloadDigest({ input, range }),
    });
    const previous = await readWorkflow(ctx.repository, lease.workId);
    if (previous && previous.lease.leaseToken === lease.leaseToken) {
      owns(previous, ctx.auth, ctx.env);
      state = previous;
    } else {
      state = {
        revision: previous?.revision ?? 0,
        lease,
        ...(isPendingRequest(input.requestId) ? { discoveryId: input.requestId } : {}),
        ...(inboxIds || limits ? { scope: { inboxIds, limits } } : {}),
        ...(range ? { range } : {}),
        chatAccountId: ctx.env.AGENDOR_CHAT_ACCOUNT_ID,
        continuation: crypto.randomUUID(),
        customerId:
          input.target.kind === 'customer'
            ? input.target.customerId
            : isPendingRequest(input.requestId) && input.target.kind === 'conversation'
              ? 'customer:chat:' + ctx.env.AGENDOR_CHAT_ACCOUNT_ID + ':' + input.target.conversationId
              : 'customer:' + lease.workId,
        step: 0,
        conversationIds: input.target.kind === 'conversation' ? [input.target.conversationId] : [],
        conversations: [],
        pages: [],
        candidates: { candidates: [], coverage: { complete: false, missingReasons: ['not_read'], pagesRead: 0 } },
      };
      await persistWorkflow(ctx.repository, state);
    }
  }
  const request: PreparationRequest = { target: state.lease.target, mode: state.lease.mode, ...state.scope };
  const settings = authorizePreparation(await ctx.policy(), request);
  const pending = state.discoveryId ? await loadPendingActivity(ctx, state.discoveryId, request) : undefined;
  if (pending?.planId) return { state: 'empty' };
  const priorDeferral = state.preparationDeferral;
  if (priorDeferral?.blocked) return blockedPreparation(state);
  if (priorDeferral?.nextRetryAt && Date.parse(priorDeferral.nextRetryAt) > Date.now())
    return {
      state: 'deferred',
      workId: state.lease.workId,
      retryAt: priorDeferral.nextRetryAt,
      leaseToken: state.lease.leaseToken,
      continuation: state.continuation,
      reason: priorDeferral.reason,
      progress: preparationProgress(state),
      noProgressAttempts: priorDeferral.attempts,
    };
  const snapshotVersion =
    state.work?.snapshotVersion ?? (await ctx.repository.getSnapshotVersion(state.lease.workId)) + 1;
  state.snapshotVersion = snapshotVersion;
  const crm = createAgendorCrmClient(ctx.env, { signal: ctx.signal });
  const chat = createAgendorChatClient(ctx.env, {
    signal: ctx.signal,
    waitForBudget: settings.limits.maxConversations > 1,
  });
  const evidence: Array<Awaited<ReturnType<typeof chat.getConversation>>> = [];
  const preparationLock = await ctx.repository.beginPreparation(state.lease);
  const validateScope = async () => {
    owns(state, ctx.auth, ctx.env);
    await ctx.repository.renewPreparation(state.lease, preparationLock);
    const policy = await ctx.policy();
    const current = authorizePreparation(policy, request);
    if (pending && discoverySettings(ctx.env, policy, [pending.inboxId]).reason)
      throw new SafeError('MCP_UNAUTHORIZED', 'Pending activity scope is no longer authorized.', false, 403);
    if (state.conversationIds.length > current.limits.maxConversations)
      unavailable('Too many conversations for the current policy; select an explicit conversation.');
    enforceInboxPolicy(evidence, { allowedInboxIds: current.inboxIds });
    enforceInboxPolicy(state.conversations, { allowedInboxIds: current.inboxIds });
  };
  try {
    if (!state.conversationIds.length) {
      if (state.lease.target.kind === 'customer') {
        state.conversationIds = await ctx.repository.getContextConversationIds(
          state.customerId,
          settings.limits.maxConversations + 1,
        );
        if (!state.conversationIds.length)
          return {
            state: 'review',
            workId: state.lease.workId,
            reviewIds: [await createReview(ctx, state, ['CUSTOMER_CONVERSATIONS_UNAVAILABLE'])],
          };
      } else unavailable('An explicit conversation or customer is required.');
      await persistWorkflow(ctx.repository, state);
    }
    if (
      request.target.kind === 'conversation' &&
      (state.conversationIds.length !== 1 || state.conversationIds[0] !== request.target.conversationId)
    )
      unavailable();
    if (state.conversations.some((c) => !state.conversationIds.includes(c.conversationId))) unavailable();
    await validateScope();
    // Re-establish every selected inbox on each call, even for cached work and
    // CRM-only continuations. A stored inbox is evidence of a past read.
    for (const conversationId of state.conversationIds) {
      const detail = pending
        ? await verifyPendingActivity(chat, pending)
        : await chat.getConversation(conversationId, { scopeOnly: true });
      if (detail.id !== conversationId)
        throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Conversation identity changed.', false);
      evidence.push(detail);
      await validateScope();
      const previous = state.conversations.find((c) => c.conversationId === conversationId);
      if (previous && previous.inboxId !== detail.inboxId) unavailable('Conversation inbox changed; prepare again.');
    }
    if (state.work) return { state: 'ready', work: state.work };
    if (state.step === 0) {
      const conversationResult = await readConversationsStep(
        ctx,
        state,
        evidence,
        chat,
        settings,
        pending,
        validateScope,
      );
      if (conversationResult) return conversationResult;
    }
    if (state.step === 1) await resolveCandidatesStep(ctx, state, crm, validateScope);
    const partialResult = await readCatalogAndHydrateStep(ctx, state, crm, snapshotVersion, validateScope);
    if (partialResult) return partialResult;
    return await finalizePreparedSnapshot(ctx, state, snapshotVersion, validateScope);
  } catch (error) {
    if (error instanceof SafeError && error.retryable)
      return await deferPreparation(ctx, state, error.code, error.retryAfterSeconds);
    try {
      await ctx.repository.recordPreparationFailure(
        state.lease.workId,
        state.lease.owner,
        error instanceof SafeError ? error.code : 'UPSTREAM_UNAVAILABLE',
      );
    } catch {
      /* Preserve the original error if persistence failed. */
    }
    throw error;
  } finally {
    try {
      await ctx.repository.endPreparation(state.lease, preparationLock);
    } catch {
      /* Lock expires automatically if release fails. */
    }
  }
}

export async function prepare(ctx: WorkflowContext, input: PrepareInput): Promise<PrepareResult> {
  requireAutomationOperation(ctx.auth, 'prepare');
  return prepareWork(ctx, input);
}
