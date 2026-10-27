import { z } from 'zod';
import type { Env } from '../env';
import { requireCapabilities, type AuthContext } from '../auth';
import { SafeError } from '../errors';
import { throwIfCancelled } from '../cancellation';
import { createAgendorChatClient, createConversationReader } from '../agendor/chat/client';
import { createAgendorCrmClient } from '../agendor/crm/client';
import { createCatalogSnapshot } from '../agendor/crm/catalog';
import { parseInput } from '../agendor/crm/schemas';
import { accountState } from './state/budget';
import { readCustomerCandidates, uniqueSources } from './identity';
import { requireAutomationOperation, requirePolicyCapabilities, authorizeSubmission, authorizePlan } from './authorization';
import { prepareInputSchema, preparedWorkSchema, analysisInputSchema, createAnalysisInputSchema, applyInputSchema, customerContextInputSchema, listReviewsInputSchema, reviewResolutionInputSchema, reprocessInputSchema } from './schemas';
import { automationPolicySchema, updatePolicyInputSchema } from './policy-types';
import { buildSyncPlan } from './planner';
import { payloadDigest } from './operations';
import { runPlan } from './executor';
import { reconcileCommand } from './reconciliation';
import { createQueueExecutionDeps, enqueueOperation } from './queue';
import type { WorkflowState } from './service-state';
import type { PrepareInput, PrepareResult, SourceRef, AutomationPolicy, OperationStatus, SyncPlan } from './types';
import type { ConfigurationInput } from '../agendor/crm/types';

export const defaultAutomationPolicy: AutomationPolicy = { version: 1, mode: 'disabled', allowedInboxIds: [], capabilities: [], funnelMapping: {}, stageMapping: [], customFieldMapping: [], nativeCreatorDisabled: false, limits: { maxConversations: 10, maxCommands: 20, maxRequests: 20 } };
const key = z.string().trim().min(1).max(200);
const unavailable = (message = 'Work is unavailable or stale; prepare again.'): never => { throw new SafeError('INVALID_INPUT', message, false, 409); };
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
    const reviewId = 'review:' + state.lease.workId;
    await repository().putReview({ reviewId, workId: state.lease.workId, customerId: state.customerId, version: 1, owner: state.lease.owner, state: 'open', reasons: [...new Set(reasons)].slice(0, 100) });
    return reviewId;
  }
  async function prepareWork(raw: PrepareInput, range?: WorkflowState['range']): Promise<PrepareResult> {
    const caller = automationActor(auth);
    const input = parseInput(prepareInputSchema, raw); throwIfCancelled(signal);
    let state: WorkflowState;
    if ('workId' in input) {
      state = await load(input.workId);
      if (state.lease.leaseToken !== input.leaseToken || state.continuation !== input.continuation) unavailable('Invalid work continuation.');
    } else {
      const lease = await repository().reserveWork({ ...input, actor: caller, payloadDigest: await payloadDigest({ input, range }) });
      const previous = await readWorkflow(repository(), lease.workId);
      if (previous && previous.lease.leaseToken === lease.leaseToken) { owns(previous, auth, env); state = previous; }
      else {
        state = { revision: previous?.revision ?? 0, lease, ...(range ? { range } : {}), chatAccountId: env.AGENDOR_CHAT_ACCOUNT_ID, continuation: crypto.randomUUID(), customerId: input.target.kind === 'customer' ? input.target.customerId : 'customer:' + lease.workId, step: 0, conversationIds: input.target.kind === 'conversation' ? [input.target.conversationId] : [], conversations: [], pages: [], candidates: { candidates: [], coverage: { complete: false, missingReasons: ['not_read'], pagesRead: 0 } } };
        await persistWorkflow(repository(), state);
      }
    }
    if (state.work) return { state: 'ready', work: state.work };
    const crm = createAgendorCrmClient(env, { signal }); const chat = createAgendorChatClient(env, { signal });
    try {
      if (!state.conversationIds.length) {
        if (state.lease.target.kind === 'customer') {
          const context = await repository().findContext(state.customerId); if (context) state.conversationIds = [...new Set(context.evidenceRefs.filter(s => s.kind === 'message').map(s => Number(s.id.split(':')[0])))].filter(id => Number.isSafeInteger(id) && id > 0).slice(0, 10);
          if (!state.conversationIds.length) return { state: 'review', workId: state.lease.workId, reviewIds: [await review(state, ['CUSTOMER_CONVERSATIONS_UNAVAILABLE'])] };
        } else {
          const discovered = await chat.listConversations();
          state.conversationIds = discovered.conversations.slice(0, 1).map(c => c.id);
          if (!state.conversationIds.length) return { state: 'empty' };
        }
        await persistWorkflow(repository(), state);
      }
      if (state.step === 0) {
        state.conversations = [];
        for (const conversationId of state.conversationIds) state.conversations.push(await createConversationReader(chat).readConversation({ conversationId }));
        if (state.range) for (const conversation of state.conversations) {
          const range = state.range;
          if (conversation.messages.some(m => m.createdAt === undefined)) { conversation.coverage.complete = false; conversation.coverage.missingReasons.push('message_time_unverified'); }
          conversation.messages = conversation.messages.filter(m => { if (m.createdAt === undefined) return false; const time = m.createdAt > 1e12 ? m.createdAt : m.createdAt * 1000; return time >= Date.parse(range.from) && time <= Date.parse(range.to); });
        }
        state.step++; await persistWorkflow(repository(), state);
      }
      if (state.step === 1) {
        const contact = state.conversations[0]?.contact;
        state.candidates = contact ? await readCustomerCandidates(crm, contact, state.conversations[0]!.revision) : { candidates: [], coverage: { complete: false, missingReasons: ['contact_unavailable'], pagesRead: 0 } };
        state.candidates.customerId = state.customerId; state.step++; await persistWorkflow(repository(), state);
      }
      const policy = await currentPolicy();
      const sections: ConfigurationInput[] = [{ section: 'funnels' }, { section: 'users' }, { section: 'products' }, ...(['organizations', 'people', 'deals'] as const).map(entityType => ({ section: 'customFields' as const, entityType })), ...[...new Set(Object.values(policy.funnelMapping))].filter((id): id is number => id !== undefined).map(funnelId => ({ section: 'stages' as const, funnelId }))];
      let catalogReads = 0;
      while (state.step - 2 < sections.length) {
        if (catalogReads >= policy.limits.maxRequests) {
          const coverage = { complete: false, missingReasons: ['catalog_preparation_pending'], pagesRead: state.pages.length };
          return { state: 'continue', workId: state.lease.workId, leaseToken: state.lease.leaseToken, continuation: state.continuation, coverage, manifest: { workId: state.lease.workId, snapshotVersion: 1, contextVersion: 0, catalogVersion: 'preparing', readAt: new Date().toISOString(), sources: [], messages: [], records: [], coverage } };
        }
        state.pages.push(await crm.getConfiguration(sections[state.step - 2]!)); state.step++; await persistWorkflow(repository(), state);
        catalogReads++;
      }
      state.catalog = createCatalogSnapshot({ accountId: 'elotenant', pages: state.pages });
      const sources: SourceRef[] = uniqueSources([...state.conversations.flatMap(c => [...c.messages.map(m => ({ kind: 'message' as const, id: `${c.conversationId}:${m.id}`, revision: c.revision })), ...(c.contact ? [{ kind: 'contact' as const, id: String(c.contact.id), revision: c.revision }] : [])]), ...state.candidates.candidates.flatMap(c => c.sourceRefs), ...(state.candidates.verifiedLinks ?? []).flatMap(c => c.sourceRefs)]);
      let markdown = ''; let contextVersion = 0;
      const context = await repository().findContext(state.customerId); if (context) { markdown = context.markdown; contextVersion = context.version; }
      const reasons = [...new Set([...state.conversations.flatMap(c => c.coverage.missingReasons), ...state.candidates.coverage.missingReasons, ...state.conversations.flatMap(c => c.attachments.length ? ['attachments_not_read'] : [])])];
      const coverage = { complete: reasons.length === 0 && state.conversations.every(c => c.coverage.complete) && state.candidates.coverage.complete, missingReasons: reasons, pagesRead: state.conversations.reduce((n, c) => n + c.coverage.pagesRead, 0) + state.candidates.coverage.pagesRead };
      state.work = preparedWorkSchema.parse({ workId: state.lease.workId, leaseToken: state.lease.leaseToken, expiresAt: state.lease.expiresAt, snapshotVersion: 1, contextVersion, customerId: state.customerId, markdown, snapshot: { conversations: state.conversations, candidates: state.candidates, catalog: state.catalog, sourceRefs: sources, records: [] }, catalogVersion: state.catalog.version, coverage });
      state.basis = { lease: state.lease, customerId: state.customerId, snapshotVersion: 1, contextVersion, catalogVersion: state.catalog.version };
      await repository().installSnapshot(state.lease, { workId: state.lease.workId, snapshotVersion: 1, contextVersion, catalogVersion: state.catalog.version, readAt: new Date().toISOString(), sources, messages: state.conversations.flatMap(c => c.messages.map(m => ({ conversationId: c.conversationId, id: m.id, revision: c.revision, hash: c.revision, direction: m.direction ?? 'unknown', ...(m.senderType ? { senderType: m.senderType } : {}), ...(m.senderId ? { senderId: m.senderId } : {}) }))), records: state.candidates.candidates.map(c => ({ ref: c.ref, revision: c.sourceRefs.find(s => s.kind === 'crm')!.revision, hash: c.sourceRefs.find(s => s.kind === 'crm')!.revision })), coverage });
      await persistWorkflow(repository(), state); return { state: 'ready', work: state.work };
    } catch (error) {
      if (error instanceof SafeError && error.retryable) return { state: 'deferred', workId: state.lease.workId, retryAt: new Date(Date.now() + 10_000).toISOString(), leaseToken: state.lease.leaseToken, continuation: state.continuation };
      throw error;
    }
  }
  async function submit(raw: unknown) {
    requireAutomationOperation(auth, 'submit'); const input = parseInput(analysisInputSchema, raw); const state = await load(input.workId);
    authorizeSubmission(auth, input, state.lease);
    if (!state.work || !state.basis || !state.catalog || input.expectedSnapshotVersion !== state.work.snapshotVersion || input.expectedContextVersion !== state.work.contextVersion || Date.now() - Date.parse(state.catalog.fetchedAt) >= 900_000) return unavailable();
    const policy = await currentPolicy();
    parseInput(createAnalysisInputSchema({ sourceRefs: (state.work.snapshot.sourceRefs ?? []).filter((s): s is SourceRef & { kind: 'message' | 'contact' | 'crm' } => s.kind !== 'operator'), candidates: state.candidates.candidates.map(c => c.ref), existingDemandIds: [], catalog: state.catalog, policy }), input);
    const resolution = await repository().resolveWork(input.analysis, state.candidates, state.catalog, state.basis);
    const plan = buildSyncPlan(input.analysis, state.work, resolution, policy);
    if (plan.state === 'review' || plan.reviewReasons?.length) { plan.state = 'review'; plan.orderedCommands = []; plan.reviewIds = [await review(state, plan.reviewReasons?.length ? plan.reviewReasons : ['ANALYSIS_REQUIRES_REVIEW'])]; }
    state.analysis = input.analysis; await repository().savePlan(plan, state.basis); await persistWorkflow(repository(), state); return plan;
  }
  async function apply(raw: unknown): Promise<OperationStatus> {
    requireAutomationOperation(auth, 'apply'); automationActor(auth); const input = parseInput(applyInputSchema, raw);
    const storedJson = await repository().getServicePlan(input.planId); if (!storedJson) return unavailable();
    const stored = JSON.parse(storedJson) as { plan: SyncPlan; workflow: WorkflowState };
    owns(stored.workflow, auth, env); const { plan, workflow } = stored;
    if (plan.version !== input.planVersion || workflow.lease.mode !== 'apply' || !workflow.basis || !workflow.catalog) return unavailable('Preview or stale plans cannot be applied.');
    const authorization = authorizePlan(auth, plan, await currentPolicy());
    const operation = await repository().prepareOperation({ requestId: input.requestId, accountKey: 'elotenant', authorization, basis: workflow.basis, catalogJson: JSON.stringify(workflow.catalog) });
    const deps = await createQueueExecutionDeps({ accountKey: 'elotenant', operationId: operation.operationId, version: operation.version }, env);
    const status = await runPlan(authorization, { ...deps, signal, defer: true });
    if (status.state === 'queued') await enqueueOperation(operation.operationId, { repository: repository(), accountKey: 'elotenant', queue: env.AUTOMATION_QUEUE });
    return status;
  }
  return { async prepare(input: PrepareInput) { requireAutomationOperation(auth, 'prepare'); return prepareWork(input); }, submit, apply,
    async getOperation(raw: string) {
      requireAutomationOperation(auth, 'operation'); const id = parseInput(key, raw); const caller = automationActor(auth); const operation = await repository().getOperation(id);
      if (!operation || operation.input.authorization.actor.userId !== caller.userId || operation.input.authorization.actor.clientId !== caller.clientId) return unavailable('Operation unavailable.');
      if (operation.status.state !== 'uncertain') return operation.status;
      const reads = createAgendorCrmClient(env, { signal }); const results = [];
      for (const command of operation.input.authorization.plan.orderedCommands) results.push(await reconcileCommand(command.commandKey, { repository: repository(), reads }));
      const pending = results.flatMap(r => r.state === 'confirmed' ? [] : r.reviewReasons);
      const status = await repository().setOperationStatus(id, { operationId: id, state: results.every(r => r.state === 'confirmed') ? 'applied' : results.some(r => r.state === 'review') ? 'review' : 'uncertain', receipts: [], pendingReasons: [...new Set(pending)].slice(0, 100) });
      if (status.state === 'applied') await repository().completeDirectOperation(id);
      return status;
    },
    async getCustomerContext(customerId: string, demandId?: string) { requireAutomationOperation(auth, 'context'); automationActor(auth); const input = parseInput(customerContextInputSchema, { customerId, ...(demandId ? { demandId } : {}) }); const context = await repository().getContext(input.customerId); return input.demandId ? { ...context, demand: await repository().getCustomerDemand(input.customerId, input.demandId) } : context; },
    async listReviews(raw: unknown) { requireAutomationOperation(auth, 'reviews'); const caller = automationActor(auth); return repository().listReviews(parseInput(listReviewsInputSchema, raw), caller); },
    async resolveReview(raw: unknown) { requireAutomationOperation(auth, 'resolveReview'); const caller = automationActor(auth); const input = parseInput(reviewResolutionInputSchema, raw); return { review: await repository().resolveReview(input, caller), actionRequired: 'prepare' as const }; },
    async getStatus() { requireAutomationOperation(auth, 'status'); const caller = automationActor(auth); return repository().getServiceStatus(caller); },
    async updatePolicy(raw: unknown) { requireAutomationOperation(auth, 'updatePolicy'); automationActor(auth); const input = parseInput(updatePolicyInputSchema, raw); const policy = automationPolicySchema.parse({ ...await currentPolicy(), ...input.patch, version: input.expectedVersion + 1 }); requirePolicyCapabilities(auth, policy); return repository().updatePolicy(policy, input.expectedVersion); },
    async reprocess(raw: unknown) { requireAutomationOperation(auth, 'reprocess'); automationActor(auth); const input = parseInput(reprocessInputSchema, raw); return prepareWork({ requestId: input.requestId, target: input.target, mode: 'preview' }, { from: input.from, to: input.to }); },
  };
}
