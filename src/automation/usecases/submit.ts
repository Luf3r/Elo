import { parseInput } from '../../agendor/crm/schemas';
import { authorizeSubmission, requireAutomationOperation } from '../../domain/authorization';
import { buildSyncPlan } from '../../domain/planner';
import { readJson } from '../../shared/json';
import { createAgendorChatClient } from '../clients';
import { verifyPendingActivity } from '../discovery';
import { payloadDigest } from '../operations';
import { analysisInputSchema, createAnalysisInputSchema } from '../schemas';
import { servicePlanEnvelopeSchema } from '../service-state';
import type { SourceRef } from '../types';
import {
  createReview,
  loadPendingActivity,
  loadWorkflow,
  persistWorkflow,
  unavailable,
  type WorkflowContext,
} from './context';
import { authorizePreparation, enforceInboxPolicy } from './policy';

export async function submit(ctx: WorkflowContext, raw: unknown) {
  requireAutomationOperation(ctx.auth, 'submit');
  const input = parseInput(analysisInputSchema, raw);
  const state = await loadWorkflow(ctx, input.workId);
  authorizeSubmission(ctx.auth, input, state.lease);
  if (
    !state.work ||
    !state.basis ||
    !state.catalog ||
    input.expectedSnapshotVersion !== state.work.snapshotVersion ||
    input.expectedContextVersion !== state.work.contextVersion ||
    Date.now() - Date.parse(state.catalog.fetchedAt) >= 900_000
  )
    return unavailable();
  const policy = await ctx.policy();
  const scope = authorizePreparation(policy, { target: state.lease.target, mode: state.lease.mode, ...state.scope });
  enforceInboxPolicy(state.conversations, { allowedInboxIds: scope.inboxIds });
  input.analysis = await ctx.repository.reviewAnalysis(input.analysis, state.basis);
  if (state.discoveryId) {
    const pending = await loadPendingActivity(ctx, state.discoveryId, {
      target: state.lease.target,
      mode: state.lease.mode,
      ...state.scope,
    });
    if (pending.planId) {
      const stored = await ctx.repository.getServicePlan(pending.planId);
      if (
        stored &&
        state.analysis &&
        state.discoveryPlanId === pending.planId &&
        (await payloadDigest(state.analysis)) === (await payloadDigest(input.analysis))
      ) {
        return readJson(servicePlanEnvelopeSchema, stored, 'servicePlan').plan;
      }
      return unavailable('This activity already has a proposal.');
    }
    await verifyPendingActivity(createAgendorChatClient(ctx.env, { signal: ctx.signal }), pending);
    if ((await ctx.policy()).version !== policy.version) return unavailable('Policy changed; refresh preparation.');
  }
  const selectedDemand = [
    ...(state.work.snapshot.deals ?? []).flatMap((d) => (d.demandId ? [d.demandId] : [])),
    ...(state.pendingReview?.decision.kind === 'selectDemand' ? [state.pendingReview.decision.demandId] : []),
  ];
  parseInput(
    createAnalysisInputSchema({
      sourceRefs: (state.work.snapshot.sourceRefs ?? []).filter(
        (s): s is SourceRef & { kind: 'message' | 'contact' | 'crm' } => s.kind !== 'operator',
      ),
      candidates: state.candidates.candidates.map((c) => c.ref),
      existingDemandIds: selectedDemand,
      catalog: state.catalog,
      policy,
    }),
    input,
  );
  const resolution = await ctx.repository.resolveWork(input.analysis, state.candidates, state.catalog, state.basis);
  const plan = buildSyncPlan(input.analysis, state.work, resolution, policy);
  if (['possible_duplicate', 'high_confidence_duplicate'].includes(state.candidates.duplicateCheck?.status ?? '')) {
    plan.reviewReasons = [...(plan.reviewReasons ?? []), 'POSSIBLE_DUPLICATE_REQUIRES_REVIEW'];
  }
  if (plan.state === 'review' || plan.reviewReasons?.length) {
    plan.state = 'review';
    plan.orderedCommands = [];
    plan.reviewIds = [
      await createReview(ctx, state, plan.reviewReasons?.length ? plan.reviewReasons : ['ANALYSIS_REQUIRES_REVIEW']),
    ];
  }
  state.analysis = input.analysis;
  await ctx.repository.savePlan(plan, state.basis);
  const demands = [];
  for (const decision of resolution.demands.demands)
    if (decision.kind === 'create' || decision.kind === 'resolved')
      demands.push(await ctx.repository.getCustomerDemand(state.customerId, decision.demandId));
  // Only structured, validated facts enter the projection. Message bodies,
  // raw attachments and Markdown supplied by an agent never enter this path.
  await ctx.repository.saveContextProjection(
    {
      customerId: state.customerId,
      version: state.basis.contextVersion + 1,
      verifiedAt: new Date().toISOString(),
      ...(resolution.customer.kind === 'resolved' ? { primaryRef: resolution.customer.ref } : {}),
      facts: input.analysis.facts,
      contacts: state.candidates.candidates.filter((c) => c.ref.kind === 'person'),
      demands,
      receipts: [],
      pendingReasons: [...(plan.reviewReasons ?? []), ...state.work.coverage.missingReasons],
      pendingPlanIds: [plan.planId],
    },
    state.basis,
  );
  if (state.discoveryId) state.discoveryPlanId = plan.planId;
  await persistWorkflow(ctx.repository, state);
  return plan;
}
