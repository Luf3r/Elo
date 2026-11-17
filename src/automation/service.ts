import {readCanonicalConversation} from '../agendor/chat/canonical';
import { allowedInboxIds, assertInboxAllowed, isInboxAllowed } from './inbox-policy';
import { z } from 'zod';
import { discoverPending, discoveryInputSchema, discoverySettings, discoveryTool, discoveryLookbackMs, discoveryCursorMs, maxDiscoveryPages, isPendingRequest, verifyPendingActivity } from './discovery';
import type { Env } from '../env';
import { requireCapabilities, type AuthContext } from '../auth';
import { SafeError } from '../errors';
import { throwIfCancelled } from '../cancellation';
import { createAgendorChatClient, createConversationReader } from '../agendor/chat/client';
import { createAgendorCrmClient } from '../agendor/crm/client';
import { createCatalogSnapshot } from '../agendor/crm/catalog';
import { parseInput } from '../agendor/crm/schemas';
import { accountState } from './state/budget';
import { readCustomerCandidates, readDuplicateCandidates, candidateLookupLinks, uniqueSources } from './identity';
import { requireAutomationOperation, requirePolicyCapabilities, authorizeSubmission, authorizePlan } from './authorization';
import { prepareInputSchema, preflightInputSchema, maxPreparationPages, preparedWorkSchema, analysisInputSchema, createAnalysisInputSchema, applyInputSchema, customerContextInputSchema, listReviewsInputSchema, reviewResolutionInputSchema, reprocessInputSchema, auditInputSchema } from './schemas';
import { automationPolicySchema, updatePolicyInputSchema } from './policy-types';
import { buildSyncPlan } from './planner';
import { payloadDigest } from './operations';
import { runPlan } from './executor';
import { reconcileCommand } from './reconciliation';
import { createQueueExecutionDeps, enqueueOperation } from './queue';
import { hydrateRecord } from './hydration';
import type { WorkflowState } from './service-state';
import type { PrepareInput, PrepareResult, SourceRef, AutomationPolicy, OperationStatus, SyncPlan } from './types';
import type { ConfigurationInput } from '../agendor/crm/types';

export const defaultAutomationPolicy: AutomationPolicy = { version: 1, mode: 'disabled', allowedInboxIds: [...allowedInboxIds], capabilities: [], funnelMapping: {}, stageMapping: [], customFieldMapping: [], nativeCreatorDisabled: false, limits: { maxConversations: 10, maxCommands: 20, maxRequests: 20 } };
const key = z.string().trim().min(1).max(200);
const unavailable = (message = 'Work is unavailable or stale; prepare again.'): never => { throw new SafeError('INVALID_INPUT', message, false, 409); };
function enforceInboxPolicy(conversations: Array<{inboxId?: number}>, policy: { allowedInboxIds: readonly number[] }): void { conversations.forEach(c=>assertInboxAllowed(c,policy)); }
type PreparationRequest = z.infer<typeof preflightInputSchema>;
function preparationSettings(policy: AutomationPolicy, input: PreparationRequest) {
  const authorized = allowedInboxIds.filter(id => isInboxAllowed(id, policy));
  const inboxIds = input.inboxIds ? [...new Set(input.inboxIds)] : authorized;
  const reason = !inboxIds.length || inboxIds.some(id => !authorized.includes(id)) ? 'INBOX_SCOPE_NOT_AUTHORIZED'
    : input.mode === 'apply' && policy.mode !== 'apply' ? 'APPLY_MODE_NOT_AUTHORIZED' : null;
  const limits = {
    maxConversations: input.target.kind === 'conversation' ? 1 : Math.min(policy.limits.maxConversations, 10),
    maxMessagePages: input.limits?.maxMessagePages ?? maxPreparationPages,
    maxAttachmentPages: input.limits?.maxAttachmentPages ?? maxPreparationPages,
    messagePageSize: 100, messagePagesPerBatch: 10, attachmentPagesPerBatch: 3,
    crmCatalogAndHydrationRequestsPerCall: policy.limits.maxRequests,
  };
  return { authorized, inboxIds, reason, limits };
}
function authorizePreparation(policy: AutomationPolicy, input: PreparationRequest) {
  const settings = preparationSettings(policy, input);
  if (input.target.kind === 'pending') unavailable('Use automation_discover_pending to find work, then prepare a returned conversation.');
  if (settings.reason) throw new SafeError('MCP_UNAUTHORIZED', 'Requested preparation scope or mode is not authorized.', false, 403);
  return settings;
}
export function automationActor(auth: AuthContext) {
  requireCapabilities(auth, []);
  if (!auth.userId || !auth.clientId || !auth.expiresAt || auth.expiresAt <= Date.now()) throw new SafeError('MCP_UNAUTHORIZED', 'A current, expiring actor authorization is required.', false, 403);
  return { userId: auth.userId, clientId: auth.clientId, scopes: [...auth.scopes], expiresAt: auth.expiresAt };
}
function owns(state: WorkflowState, auth: AuthContext, env: Env) {
  const caller = automationActor(auth);
  if (state.lease.owner.userId !== caller.userId || state.lease.owner.clientId !== caller.clientId || Date.parse(state.lease.expiresAt) <= Date.now() || state.chatAccountId !== undefined && state.chatAccountId !== env.AGENDOR_CHAT_ACCOUNT_ID) unavailable();
}
export async function persistWorkflow(repository: ReturnType<typeof accountState>, state: WorkflowState) {
  const expected = state.revision; state.revision++;
  await repository.saveWorkflow(state, expected);
}
export async function readWorkflow(repository: ReturnType<typeof accountState>, id: string): Promise<WorkflowState | undefined> { const json = await repository.getWorkflow(id); return json ? JSON.parse(json) as WorkflowState : undefined; }
/** Authorization precedes adapter construction. Account, evidence and commands
 * are always loaded from server-owned state rather than caller claims. */
export function createAutomationService(env: Env, auth: AuthContext, signal?: AbortSignal) {
  const repository = () => accountState(env);
  const currentPolicy = async () => await repository().getExecutionPolicy() ?? structuredClone(defaultAutomationPolicy);
  async function load(id: string) {
    const state = await readWorkflow(repository(), id);
    if (!state) return unavailable();
    owns(state, auth, env); return state;
  }
  async function review(state: WorkflowState, reasons: string[]) {
    const reviewId = 'review:' + state.lease.workId + ':' + (state.work?.snapshotVersion ?? state.snapshotVersion ?? 1);
    await repository().putReview({ reviewId, workId: state.lease.workId, customerId: state.customerId, version: 1, snapshotVersion: state.work?.snapshotVersion ?? state.snapshotVersion ?? 1, owner: state.lease.owner, state: 'open', reasons: [...new Set(reasons)].slice(0, 100) });
    return reviewId;
  }
  async function loadPending(id: string, request: PreparationRequest) {
    const event = await repository().getPendingActivity(id);
    if (!event || event.accountId !== env.AGENDOR_CHAT_ACCOUNT_ID || request.mode !== 'preview'
        || request.target.kind !== 'conversation' || request.target.conversationId !== event.conversationId
        || request.inboxIds?.length !== 1 || request.inboxIds[0] !== event.inboxId)
      return unavailable('Pending activity is unavailable or outside the requested scope.');
    if (discoverySettings(env, await currentPolicy(), [event.inboxId]).reason)
      throw new SafeError('MCP_UNAUTHORIZED', 'Pending activity scope is not authorized.', false, 403);
    return event;
  }
  function progress(state: WorkflowState) {
    return {
      stage: state.step === 0 ? 'conversation' as const : state.step === 1 ? 'candidates' as const : state.catalog ? 'hydration' as const : 'catalog' as const,
      messagePages: state.conversations.reduce((sum, c) => sum + (c.coverage.history?.pagesRead ?? 0), 0),
      messages: state.conversations.reduce((sum, c) => sum + c.messages.length, 0),
      attachmentPages: state.conversations.reduce((sum, c) => sum + (c.attachmentListing?.pagesRead ?? 0), 0),
      catalogPages: state.pages.length,
      candidateLookups: Object.keys(state.candidateReadCache ?? {}).length,
      hydrated: state.hydration?.offset ?? 0,
    };
  }
  function blocked(state: WorkflowState): PrepareResult {
    return { state: 'blocked', workId: state.lease.workId, reason: 'PREPARATION_NO_PROGRESS', lastReason: state.preparationDeferral?.reason ?? 'UPSTREAM_UNAVAILABLE', progress: progress(state), leaseExpiresAt: state.lease.expiresAt, recovery: 'Reinicie a preparação com o mesmo requestId após a expiração do lease e verifique a auditoria.' };
  }
  async function defer(state: WorkflowState, reason: string, retryAfterSeconds = 10): Promise<PrepareResult> {
    const snapshot = progress(state);
    const checkpoint = JSON.stringify(snapshot);
    const attempts = state.preparationDeferral?.checkpoint === checkpoint ? state.preparationDeferral.attempts + 1 : 1;
    const nextRetryAt = new Date(Date.now() + Math.max(1, retryAfterSeconds) * 1000).toISOString();
    state.preparationDeferral = { checkpoint, attempts, reason, blocked: attempts >= 5, nextRetryAt };
    await persistWorkflow(repository(), state);
    if (state.preparationDeferral.blocked) return blocked(state);
    return { state: 'deferred', workId: state.lease.workId, retryAt: nextRetryAt, leaseToken: state.lease.leaseToken, continuation: state.continuation, reason, progress: snapshot, noProgressAttempts: attempts };
  }
  async function prepareWork(raw: PrepareInput, range?: WorkflowState['range']): Promise<PrepareResult> {
    const caller = automationActor(auth);
    const input = parseInput(prepareInputSchema, raw); throwIfCancelled(signal);
    if ('target' in input) {
      authorizePreparation(await currentPolicy(), input);
      if (isPendingRequest(input.requestId) && (await loadPending(input.requestId, input)).planId) return { state: 'empty' };
    }
    let state: WorkflowState;
    if ('workId' in input) {
      state = await load(input.workId);
      if (state.lease.leaseToken !== input.leaseToken || state.continuation !== input.continuation || state.discoveryId && state.discoveryId !== input.requestId) unavailable('Invalid work continuation.');
    } else {
      const { inboxIds, limits, ...request } = input;
      const lease = await repository().reserveWork({ ...request, actor: caller, payloadDigest: await payloadDigest({ input, range }) });
      const previous = await readWorkflow(repository(), lease.workId);
      if (previous && previous.lease.leaseToken === lease.leaseToken) { owns(previous, auth, env); state = previous; }
      else {
        state = { revision: previous?.revision ?? 0, lease, ...(isPendingRequest(input.requestId) ? { discoveryId: input.requestId } : {}), ...(inboxIds || limits ? { scope: { inboxIds, limits } } : {}), ...(range ? { range } : {}), chatAccountId: env.AGENDOR_CHAT_ACCOUNT_ID, continuation: crypto.randomUUID(), customerId: input.target.kind === 'customer' ? input.target.customerId : isPendingRequest(input.requestId) && input.target.kind === 'conversation' ? 'customer:chat:' + env.AGENDOR_CHAT_ACCOUNT_ID + ':' + input.target.conversationId : 'customer:' + lease.workId, step: 0, conversationIds: input.target.kind === 'conversation' ? [input.target.conversationId] : [], conversations: [], pages: [], candidates: { candidates: [], coverage: { complete: false, missingReasons: ['not_read'], pagesRead: 0 } } };
        await persistWorkflow(repository(), state);
      }
    }
    const request: PreparationRequest = { target: state.lease.target, mode: state.lease.mode, ...state.scope };
    const settings = authorizePreparation(await currentPolicy(), request);
    const pending = state.discoveryId ? await loadPending(state.discoveryId, request) : undefined;
    if (pending?.planId) return { state: 'empty' };
    const priorDeferral = state.preparationDeferral;
    if (priorDeferral?.blocked) return blocked(state);
    if (priorDeferral?.nextRetryAt && Date.parse(priorDeferral.nextRetryAt) > Date.now()) return { state: 'deferred', workId: state.lease.workId, retryAt: priorDeferral.nextRetryAt, leaseToken: state.lease.leaseToken, continuation: state.continuation, reason: priorDeferral.reason, progress: progress(state), noProgressAttempts: priorDeferral.attempts };
    const snapshotVersion = state.work?.snapshotVersion ?? (await repository().getSnapshotVersion(state.lease.workId)) + 1;
    state.snapshotVersion = snapshotVersion;
    const crm = createAgendorCrmClient(env, { signal });
    const chat = createAgendorChatClient(env, { signal, waitForBudget: settings.limits.maxConversations > 1 });
    const evidence: Array<Awaited<ReturnType<typeof chat.getConversation>>> = [];
    const preparationLock = await repository().beginPreparation(state.lease);
    const validateScope = async () => {
      owns(state, auth, env);
      await repository().renewPreparation(state.lease, preparationLock);
      const policy = await currentPolicy();
      const current = authorizePreparation(policy, request);
      if (pending && discoverySettings(env, policy, [pending.inboxId]).reason) throw new SafeError('MCP_UNAUTHORIZED', 'Pending activity scope is no longer authorized.', false, 403);
      if (state.conversationIds.length > current.limits.maxConversations) unavailable('Too many conversations for the current policy; select an explicit conversation.');
      enforceInboxPolicy(evidence, { allowedInboxIds: current.inboxIds });
      enforceInboxPolicy(state.conversations, { allowedInboxIds: current.inboxIds });
    };
    try {
      if (!state.conversationIds.length) {
        if (state.lease.target.kind === 'customer') {
          state.conversationIds = await repository().getContextConversationIds(state.customerId, settings.limits.maxConversations + 1);
          if (!state.conversationIds.length) return { state: 'review', workId: state.lease.workId, reviewIds: [await review(state, ['CUSTOMER_CONVERSATIONS_UNAVAILABLE'])] };
        } else unavailable('An explicit conversation or customer is required.');
        await persistWorkflow(repository(), state);
      }
      if (request.target.kind === 'conversation' && (state.conversationIds.length !== 1 || state.conversationIds[0] !== request.target.conversationId)) unavailable();
      if (state.conversations.some(c => !state.conversationIds.includes(c.conversationId))) unavailable();
      await validateScope();
      // Re-establish every selected inbox on each call, even for cached work and
      // CRM-only continuations. A stored inbox is evidence of a past read.
      for (const conversationId of state.conversationIds) {
        const detail = pending ? await verifyPendingActivity(chat, pending) : await chat.getConversation(conversationId, { scopeOnly: true });
        if (detail.id !== conversationId) throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Conversation identity changed.', false);
        evidence.push(detail);
        await validateScope();
        const previous = state.conversations.find(c => c.conversationId === conversationId);
        if (previous && previous.inboxId !== detail.inboxId) unavailable('Conversation inbox changed; prepare again.');
      }
      if (state.work) return { state: 'ready', work: state.work };
      if (state.step === 0) {
        for (const detail of evidence) {
          const conversationId = detail.id;
          const previous = state.conversations.find(c=>c.conversationId===conversationId);
          if (previous && !previous.continuation && !previous.attachmentListing?.nextPage) continue;
          const save = async (snapshot: import('../agendor/chat/types').ConversationSnapshot) => {
            const index=state.conversations.findIndex(c=>c.conversationId===conversationId);
            if(index<0) state.conversations.push(snapshot); else state.conversations[index]=snapshot;
            await persistWorkflow(repository(),state);
          };
          const reader = createConversationReader({
            getConversation: id => readCanonicalConversation({
              getConversation: async () => detail,
              getContact: async contactId => { await validateScope(); return chat.getContact(contactId); },
            }, id, { allowedInboxIds: settings.inboxIds }),
            listAttachments: (id, options) => chat.listAttachments(id, { ...options, beforePage: validateScope }),
            listMessages: async (id, options) => { await validateScope(); return chat.listMessages(id, options); },
          });
          const snapshot = await reader.readConversation({ conversationId }, {
            previous, onProgress: save, maxMessagePages: settings.limits.maxMessagePages, maxAttachmentPages: settings.limits.maxAttachmentPages,
          });
          const invalidHistory = snapshot.coverage.missingReasons.filter(reason => ['conversation_mismatch', 'message_cursor_invalid', 'cursor_repeated', 'cursor_invalid', 'history_query_failed'].includes(reason));
          if (invalidHistory.length) return { state: 'review', workId: state.lease.workId, reviewIds: [await review(state, invalidHistory)] };
          if(snapshot.continuation || snapshot.attachmentListing?.nextPage) {
            if(snapshot.continuation && snapshot.messages.length>=10000) return {state:'review',workId:state.lease.workId,reviewIds:[await review(state,snapshot.coverage.missingReasons)]};
            return await defer(state, 'MORE_PAGES');
          }
        }
        await validateScope();
        if (state.range) for (const conversation of state.conversations) {
          const range = state.range;
          if (conversation.messages.some(m => m.createdAt === undefined)) { conversation.coverage.complete = false; conversation.coverage.missingReasons.push('message_time_unverified'); }
          conversation.messages = conversation.messages.filter(m => { if (m.createdAt === undefined) return false; const time = m.createdAt > 1e12 ? m.createdAt : m.createdAt * 1000; return time >= Date.parse(range.from) && time <= Date.parse(range.to); });
        }
        state.step++; await persistWorkflow(repository(), state);
        if (!pending) for (const conversationId of state.conversationIds) await repository().acknowledgeChatHints(conversationId);
      }
      if (state.step === 1) {
        await validateScope();
        const contact = state.conversations[0]?.contact;
        // Cache successful reads in server-owned work state before requesting another
        // page, so a shared-budget deferral cannot restart the same search forever.
        const remembered = async <T>(key:string,load:()=>Promise<T>):Promise<T> => {
          await validateScope();
          state.candidateReadCache ??= {};
          const cached=state.candidateReadCache[key];if(cached!==undefined)return JSON.parse(cached) as T;
          const value=await load();const json=JSON.stringify(value);
          if(Object.values(state.candidateReadCache).reduce((n,v)=>n+v.length,0)+json.length>500_000) throw new SafeError('UPSTREAM_INVALID_RESPONSE','Candidate read cache exceeded the work limit.',false);
          state.candidateReadCache[key]=json;await persistWorkflow(repository(),state);return value;
        };
        const candidatesCrm={getPerson:(id:number)=>remembered('person:'+id,()=>crm.getPerson(id)),searchPeople:(input:Parameters<typeof crm.searchPeople>[0])=>remembered('people:'+JSON.stringify(input),()=>crm.searchPeople(input)),searchOrganizations:(input:Parameters<typeof crm.searchOrganizations>[0])=>remembered('organizations:'+JSON.stringify(input),()=>crm.searchOrganizations(input))};
        state.candidates = contact ? await readCustomerCandidates(candidatesCrm, contact, state.conversations[0]!.revision) : { candidates: [], coverage: { complete: false, missingReasons: ['contact_unavailable'], pagesRead: 0 } };
        if(state.candidates.crmContactLink?.status==='verified') {
          const person=state.candidates.candidates.find(c=>c.ref.kind==='person' && c.ref.id===state.candidates.crmContactLink!.crmPersonId);
          if(person) state.candidates.duplicateCheck=await readDuplicateCandidates(candidatesCrm,person);
        }
        if (state.lease.target.kind === 'conversation') {
          const linked = await repository().findLinkedCustomer(candidateLookupLinks(state.candidates));
          if (linked.customerId) state.customerId = linked.customerId;
          if (linked.ambiguous) { state.candidates.coverage.complete = false; state.candidates.coverage.missingReasons.push('customer_binding_ambiguous'); }
        }
        state.candidates.customerId = state.customerId; state.step++; await persistWorkflow(repository(), state);
      }
      const policy = await currentPolicy();
      const sections: ConfigurationInput[] = [{ section: 'funnels' }, { section: 'users' }, { section: 'products' }, ...(['organizations', 'people', 'deals'] as const).map(entityType => ({ section: 'customFields' as const, entityType })), ...[...new Set(Object.values(policy.funnelMapping))].filter((id): id is number => id !== undefined).map(funnelId => ({ section: 'stages' as const, funnelId }))];
      let catalogReads = 0;
      while (state.step - 2 < sections.length) {
        if (catalogReads >= policy.limits.maxRequests) {
          const coverage = { complete: false, missingReasons: ['catalog_preparation_pending'], pagesRead: state.pages.length };
          return { state: 'continue', workId: state.lease.workId, leaseToken: state.lease.leaseToken, continuation: state.continuation, coverage, manifest: { workId: state.lease.workId, snapshotVersion, contextVersion: 0, catalogVersion: 'preparing', readAt: new Date().toISOString(), sources: [], messages: [], records: [], coverage } };
        }
        await validateScope();
        state.pages.push(await crm.getConfiguration(sections[state.step - 2]!)); state.step++; await persistWorkflow(repository(), state);
        catalogReads++;
      }
      state.catalog = createCatalogSnapshot({ accountId: 'elotenant', pages: state.pages });
      await validateScope();
      const retained = await repository().getPreparationBasis(state.customerId);
      state.hydration ??= { offset: 0, records: [], deals: [], sources: [], missingReasons: [] };
      const hydration = state.hydration;
      const targets = [...state.candidates.candidates.map(c => ({ ref: c.ref, demand: undefined })), ...retained.demands.flatMap(d => d.dealRef ? [{ ref: d.dealRef, demand: d }] : [])].slice(0, 100);
      if (retained.demands.length > 100 || retained.commands.length > 500 || state.candidates.candidates.length + retained.demands.filter(d => d.dealRef).length > 100) hydration.missingReasons.push('crm_hydration_limit');
      while (hydration.offset < targets.length) {
        if (catalogReads >= policy.limits.maxRequests) {
          const coverage = { complete: false, missingReasons: ['crm_preparation_pending'], pagesRead: hydration.offset };
          await persistWorkflow(repository(), state);
          return { state: 'continue', workId: state.lease.workId, leaseToken: state.lease.leaseToken, continuation: state.continuation, coverage, manifest: { workId: state.lease.workId, snapshotVersion, contextVersion: 0, catalogVersion: state.catalog.version, readAt: new Date().toISOString(), sources: [], messages: [], records: [], coverage } };
        }
        const target = targets[hydration.offset]!;
        await validateScope();
        try {
          const raw = target.ref.kind === 'person' ? await crm.getPerson(target.ref.id) : target.ref.kind === 'organization' ? await crm.getOrganization(target.ref.id) : await crm.getDeal(target.ref.id);
          const result = await hydrateRecord(raw, target.ref, state.catalog, policy, retained.commands, target.demand);
          hydration.records.push(result.record); hydration.sources.push(result.source); if (result.deal) hydration.deals.push(result.deal);
          const candidate = state.candidates.candidates.find(c => c.ref.kind === target.ref.kind && c.ref.id === target.ref.id);
          if (candidate) {
            candidate.sourceRefs = [result.source];
            candidate.name = String(result.record.fields.find(f => f.field === 'name')!.value);
            const email = result.record.fields.find(f => f.field === 'email')?.value;
            const phone = result.record.fields.find(f => f.field === 'phone')?.value;
            const document = result.record.fields.find(f => f.field === 'cnpj')?.value;
            if (typeof email === 'string') candidate.email = email; else delete candidate.email;
            if (typeof phone === 'string') candidate.phone = phone; else delete candidate.phone;
            if (typeof document === 'string') candidate.document = document; else delete candidate.document;
            const organization = raw && typeof raw === 'object' && 'organization' in raw ? raw.organization : undefined;
            const organizationId = typeof organization === 'number' ? organization : organization && typeof organization === 'object' && 'id' in organization ? organization.id : undefined;
            candidate.organizationIds = typeof organizationId === 'number' && Number.isSafeInteger(organizationId) && organizationId > 0 ? [organizationId] : [];
            for (const link of state.candidates.verifiedLinks ?? []) if (link.ref.kind === target.ref.kind && link.ref.id === target.ref.id) link.sourceRefs = [...link.sourceRefs.filter(s => s.kind !== 'crm'), result.source];
          }
        } catch (error) {
          if (error instanceof SafeError && error.retryable) throw error;
          hydration.missingReasons.push('crm_record_unverified');
        }
        hydration.offset++; catalogReads++; await persistWorkflow(repository(), state);
      }
      const sources: SourceRef[] = uniqueSources([...state.conversations.flatMap(c => [...c.messages.map(m => ({ kind: 'message' as const, id: `${c.conversationId}:${m.id}`, revision: c.revision })), ...(c.contact ? [{ kind: 'contact' as const, id: String(c.contact.id), revision: c.revision }] : [])]), ...state.candidates.candidates.flatMap(c => c.sourceRefs), ...(state.candidates.verifiedLinks ?? []).flatMap(c => c.sourceRefs), ...hydration.sources]);
      await validateScope();
      let markdown = ''; let contextVersion = 0;
      const context = await repository().findContext(state.customerId); if (context) { markdown = context.markdown; contextVersion = context.version; }
      const reasons = [...new Set([...state.conversations.flatMap(c => c.coverage.missingReasons), ...state.candidates.coverage.missingReasons, ...hydration.missingReasons, ...state.conversations.flatMap(c => c.attachments.length ? ['attachments_not_read'] : [])])];
      const coverage = { complete: reasons.length === 0 && state.conversations.every(c => c.coverage.complete) && state.candidates.coverage.complete, missingReasons: reasons, pagesRead: state.conversations.reduce((n, c) => n + c.coverage.pagesRead, 0) + state.candidates.coverage.pagesRead };
      state.work = preparedWorkSchema.parse({ workId: state.lease.workId, leaseToken: state.lease.leaseToken, expiresAt: state.lease.expiresAt, snapshotVersion, contextVersion, customerId: state.customerId, markdown, snapshot: { conversations: state.conversations, candidates: state.candidates, catalog: state.catalog, sourceRefs: sources, records: hydration.records, deals: hydration.deals }, catalogVersion: state.catalog.version, coverage, ...(state.pendingReview ? { reviewDecision: { reviewId: state.pendingReview.reviewId, version: state.pendingReview.version, decision: state.pendingReview.decision } } : {}) });
      state.basis = { lease: state.lease, customerId: state.customerId, snapshotVersion, contextVersion, catalogVersion: state.catalog.version };
      await validateScope();
      state.revision++;
      await repository().installSnapshot(state.lease, { workId: state.lease.workId, snapshotVersion, contextVersion, catalogVersion: state.catalog.version, readAt: new Date().toISOString(), sources, messages: state.conversations.flatMap(c => c.messages.map(m => ({ conversationId: c.conversationId, id: m.id, revision: c.revision, hash: c.revision, direction: m.direction ?? 'unknown', ...(m.senderType ? { senderType: m.senderType } : {}), ...(m.senderId ? { senderId: m.senderId } : {}) }))), records: [...state.candidates.candidates.map(c => ({ ref: c.ref, revision: c.sourceRefs.find(s => s.kind === 'crm')!.revision, hash: c.sourceRefs.find(s => s.kind === 'crm')!.revision })), ...hydration.deals.map(d => ({ ref: d.ref, revision: d.revision, hash: d.revision }))], coverage }, state);
      return { state: 'ready', work: state.work };
    } catch (error) {
      if (error instanceof SafeError && error.retryable) return await defer(state, error.code, error.retryAfterSeconds);
      try { await repository().recordPreparationFailure(state.lease.workId, state.lease.owner, error instanceof SafeError ? error.code : 'UPSTREAM_UNAVAILABLE'); } catch { /* Preserve the original error if persistence failed. */ }
      throw error;
    } finally {
      try { await repository().endPreparation(state.lease, preparationLock); } catch { /* Lock expires automatically if release fails. */ }
    }
  }
  async function submit(raw: unknown) {
    requireAutomationOperation(auth, 'submit'); const input = parseInput(analysisInputSchema, raw); const state = await load(input.workId);
    authorizeSubmission(auth, input, state.lease);
    if (!state.work || !state.basis || !state.catalog || input.expectedSnapshotVersion !== state.work.snapshotVersion || input.expectedContextVersion !== state.work.contextVersion || Date.now() - Date.parse(state.catalog.fetchedAt) >= 900_000) return unavailable();
    const policy = await currentPolicy();
    const scope = authorizePreparation(policy, { target: state.lease.target, mode: state.lease.mode, ...state.scope });
    enforceInboxPolicy(state.conversations, { allowedInboxIds: scope.inboxIds });
    input.analysis = await repository().reviewAnalysis(input.analysis, state.basis);
    if (state.discoveryId) {
      const pending = await loadPending(state.discoveryId, { target: state.lease.target, mode: state.lease.mode, ...state.scope });
      if (pending.planId) {
        const stored = await repository().getServicePlan(pending.planId);
        if (stored && state.analysis && state.discoveryPlanId === pending.planId && await payloadDigest(state.analysis) === await payloadDigest(input.analysis)) {
          return (JSON.parse(stored) as { plan: SyncPlan }).plan;
        }
        return unavailable('This activity already has a proposal.');
      }
      await verifyPendingActivity(createAgendorChatClient(env, { signal }), pending);
      if ((await currentPolicy()).version !== policy.version) return unavailable('Policy changed; refresh preparation.');
    }
    const selectedDemand = [...(state.work.snapshot.deals ?? []).flatMap(d => d.demandId ? [d.demandId] : []), ...(state.pendingReview?.decision.kind === 'selectDemand' ? [state.pendingReview.decision.demandId] : [])];
    parseInput(createAnalysisInputSchema({ sourceRefs: (state.work.snapshot.sourceRefs ?? []).filter((s): s is SourceRef & { kind: 'message' | 'contact' | 'crm' } => s.kind !== 'operator'), candidates: state.candidates.candidates.map(c => c.ref), existingDemandIds: selectedDemand, catalog: state.catalog, policy }), input);
    const resolution = await repository().resolveWork(input.analysis, state.candidates, state.catalog, state.basis);
    const plan = buildSyncPlan(input.analysis, state.work, resolution, policy);
    if(['possible_duplicate','high_confidence_duplicate'].includes(state.candidates.duplicateCheck?.status ?? '')) {plan.reviewReasons=[...(plan.reviewReasons ?? []),'POSSIBLE_DUPLICATE_REQUIRES_REVIEW'];}
    if (plan.state === 'review' || plan.reviewReasons?.length) { plan.state = 'review'; plan.orderedCommands = []; plan.reviewIds = [await review(state, plan.reviewReasons?.length ? plan.reviewReasons : ['ANALYSIS_REQUIRES_REVIEW'])]; }
    state.analysis = input.analysis; await repository().savePlan(plan, state.basis);
    const demands = [];
    for (const decision of resolution.demands.demands) if (decision.kind === 'create' || decision.kind === 'resolved') demands.push(await repository().getCustomerDemand(state.customerId, decision.demandId));
    // Only structured, validated facts enter the projection. Message bodies,
    // raw attachments and Markdown supplied by an agent never enter this path.
    await repository().saveContextProjection({ customerId: state.customerId, version: state.basis.contextVersion + 1, verifiedAt: new Date().toISOString(), ...(resolution.customer.kind === 'resolved' ? { primaryRef: resolution.customer.ref } : {}), facts: input.analysis.facts, contacts: state.candidates.candidates.filter(c => c.ref.kind === 'person'), demands, receipts: [], pendingReasons: [...(plan.reviewReasons ?? []), ...state.work.coverage.missingReasons], pendingPlanIds: [plan.planId] }, state.basis);
    if (state.discoveryId) state.discoveryPlanId = plan.planId;
    await persistWorkflow(repository(), state); return plan;
  }
  async function apply(raw: unknown): Promise<OperationStatus> {
    requireAutomationOperation(auth, 'apply'); automationActor(auth); const input = parseInput(applyInputSchema, raw);
    const policy = await currentPolicy();
    if (policy.mode !== 'apply') throw new SafeError('MCP_UNAUTHORIZED', 'The current policy does not authorize plan application.', false, 403);
    // Context publication invalidates the source plan. An exact completed
    // replay still returns its receipt without reauthorizing any dispatch.
    const prior = await repository().getOperationByRequest(input.requestId);
    if (prior?.status.state === 'applied') {
      const caller = automationActor(auth); const original = prior.input.authorization;
      const workflow = await readWorkflow(repository(), prior.input.basis.lease.workId);
      if (original.actor.userId !== caller.userId || original.actor.clientId !== caller.clientId || original.plan.planId !== input.planId || original.plan.version !== input.planVersion || !workflow || workflow.chatAccountId !== env.AGENDOR_CHAT_ACCOUNT_ID) return unavailable();
      return prior.status;
    }
    const storedJson = await repository().getServicePlan(input.planId); if (!storedJson) return unavailable();
    const stored = JSON.parse(storedJson) as { plan: SyncPlan; workflow: WorkflowState };
    owns(stored.workflow, auth, env); const { plan, workflow } = stored;
    if (plan.version !== input.planVersion || workflow.lease.mode !== 'apply' || !workflow.basis || !workflow.catalog) return unavailable('Preview or stale plans cannot be applied.');
    enforceInboxPolicy(workflow.conversations, policy); const authorization = authorizePlan(auth, plan, policy);
    const operation = await repository().prepareOperation({ requestId: input.requestId, accountKey: 'elotenant', authorization, basis: workflow.basis, catalogJson: JSON.stringify(workflow.catalog) });
    const deps = await createQueueExecutionDeps({ accountKey: 'elotenant', operationId: operation.operationId, version: operation.version }, env);
    const status = await runPlan(authorization, { ...deps, signal, defer: true });
    if (status.state === 'queued') await enqueueOperation(operation.operationId, { repository: repository(), accountKey: 'elotenant', queue: env.AUTOMATION_QUEUE });
    return status;
  }
  return {
    async discover(raw: unknown) {
      requireAutomationOperation(auth, 'discover');
      const { userId, clientId } = automationActor(auth);
      return discoverPending(env, { userId, clientId }, parseInput(discoveryInputSchema, raw), currentPolicy, signal);
    },
    async preflight(raw: unknown) {
      requireAutomationOperation(auth, 'preflight');
      const identity = automationActor(auth);
      const input = parseInput(preflightInputSchema, raw);
      const scope = { target: input.target, requestedMode: input.mode, requestedInboxIds: input.inboxIds ?? null, conversationVerification: 'required_at_prepare' as const, upstreamDetailMayIncludeMessages: true };
      let infrastructure;
      try { infrastructure = await repository().getPreparationInfrastructure(); }
      catch {
        return { state: 'blocked', reason: 'STATE_UNAVAILABLE', identity, policyVersion: null, policyMode: null, effectiveMode: null, allowedInboxIds: null,
          scope: { ...scope, inboxIds: null }, limits: null, persistence: { available: false }, concurrency: { available: false } };
      }
      const policy = infrastructure.policy ?? defaultAutomationPolicy;
      const settings = preparationSettings(policy, input);
      const pending = input.target.kind === 'pending';
      const discovery = pending ? discoverySettings(env, policy, input.inboxIds) : undefined;
      const reason = settings.reason ?? (pending && input.mode !== 'preview' ? 'DISCOVERY_PREVIEW_ONLY' : discovery?.reason ?? null);
      return { state: reason ? 'blocked' : pending ? 'ready_for_discovery' : 'ready_for_scope_check', reason, identity,
        ...(pending ? { discovery: { tool: discoveryTool, mode: 'preview', maxPagesPerCall: 1, inboxInventoryCheckedBeforeEachCall: true, maxPagesPerInbox: maxDiscoveryPages, cursorSeconds: discoveryCursorMs / 1000, lookbackSeconds: discoveryLookbackMs / 1000 } } : {}),
        policyVersion: policy.version, policyMode: policy.mode, effectiveMode: input.mode === 'preview' ? 'preview' : policy.mode,
        allowedInboxIds: settings.authorized, scope: { ...scope, inboxIds: reason ? [] : settings.inboxIds }, limits: settings.limits,
        persistence: { available: true, mechanism: 'durable_object_sqlite' },
        concurrency: { available: true, mechanism: 'target_lease', leaseSeconds: 600, preparationLockSeconds: 60 },
      };
    },
    async prepare(input: PrepareInput) { requireAutomationOperation(auth, 'prepare'); return prepareWork(input); }, submit, apply,
    async getOperation(raw: string) {
      requireAutomationOperation(auth, 'operation'); const id = parseInput(key, raw); const caller = automationActor(auth); const operation = await repository().getOperation(id);
      if (!operation || operation.input.authorization.actor.userId !== caller.userId || operation.input.authorization.actor.clientId !== caller.clientId) return unavailable('Operation unavailable.');
      const workflow = await readWorkflow(repository(), operation.input.basis.lease.workId);
      if (!workflow || workflow.chatAccountId !== undefined && workflow.chatAccountId !== env.AGENDOR_CHAT_ACCOUNT_ID) return unavailable('Operation unavailable.');
      if (operation.status.state !== 'uncertain') return operation.status;
      const reads = createAgendorCrmClient(env, { signal }); const results = [];
      for (const command of operation.input.authorization.plan.orderedCommands) results.push(await reconcileCommand(command.commandKey, { repository: repository(), reads }));
      const pending = results.flatMap(r => r.state === 'confirmed' ? [] : r.reviewReasons);
      const status = await repository().setOperationStatus(id, { operationId: id, state: results.every(r => r.state === 'confirmed') ? 'applied' : results.some(r => r.state === 'review') ? 'review' : 'uncertain', receipts: [], pendingReasons: [...new Set(pending)].slice(0, 100) });
      if (status.state === 'applied') await repository().publishOperationContext(id);
      return status;
    },
    async getCustomerContext(customerId: string, demandId?: string) { requireAutomationOperation(auth, 'context'); automationActor(auth); const input = parseInput(customerContextInputSchema, { customerId, ...(demandId ? { demandId } : {}) }); const context = await repository().getContext(input.customerId); return input.demandId ? { ...context, demand: await repository().getCustomerDemand(input.customerId, input.demandId) } : context; },
    async listReviews(raw: unknown) { requireAutomationOperation(auth, 'reviews'); const caller = automationActor(auth); return repository().listReviews(parseInput(listReviewsInputSchema, raw), caller); },
    async resolveReview(raw: unknown) { requireAutomationOperation(auth, 'resolveReview'); const caller = automationActor(auth); const input = parseInput(reviewResolutionInputSchema, raw); return { review: await repository().resolveReview(input, caller), actionRequired: 'prepare' as const }; },
    async getStatus() { requireAutomationOperation(auth, 'status'); const caller = automationActor(auth); return repository().getServiceStatus(caller); },
    async getAudit(raw: unknown) { requireAutomationOperation(auth, 'status'); const caller = automationActor(auth); return repository().listAudit(parseInput(auditInputSchema, raw), caller); },
    async updatePolicy(raw: unknown) { requireAutomationOperation(auth, 'updatePolicy'); const caller = automationActor(auth); const input = parseInput(updatePolicyInputSchema, raw); const policy = automationPolicySchema.parse({ ...await currentPolicy(), ...input.patch, version: input.expectedVersion + 1 }); requirePolicyCapabilities(auth, policy); return repository().updatePolicy(policy, input.expectedVersion, caller); },
    async reprocess(raw: unknown) { requireAutomationOperation(auth, 'reprocess'); const caller = automationActor(auth); const input = parseInput(reprocessInputSchema, raw); await repository().recordReprocess(input.requestId, caller); return prepareWork({ requestId: input.requestId, target: input.target, mode: input.mode }, { from: input.from, to: input.to }); },
  };
}
