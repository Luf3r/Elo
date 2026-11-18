import { createOrganizationSchema, createPersonSchema } from '../shared/contracts/crm-mutations';
import { automationPolicySchema, type AutomationPolicy } from './policy-types';
import { createAnalysisInputSchema, type AgentAnalysis } from './schemas/analysis';
import { factSchema, type Fact, type SourceRef } from './schemas/common';
import {
  resolutionBundleSchema,
  syncPlanSchema,
  type MutationCommand,
  type PlannerDecision,
  type ResolutionBundle,
  type SyncPlan,
} from './schemas/planning';
import { preparedWorkSchema, type PreparedWork } from './schemas/snapshot';
import { buildFieldPatch } from './fields';
import { uniqueSources } from './identity';
import { decideDemand, meta, sameSource } from './planner-demand';

const sameRef = (a: { kind: string; id: number }, b: { kind: string; id: number }) =>
  a.kind === b.kind && a.id === b.id;

function knownSources(work: PreparedWork): SourceRef[] {
  if (work.snapshot.sourceRefs) return work.snapshot.sourceRefs;
  return uniqueSources([
    ...work.snapshot.conversations.flatMap((c) => [
      ...c.messages.map((m) => ({ kind: 'message' as const, id: `${c.conversationId}:${m.id}`, revision: c.revision })),
      ...(c.contact ? [{ kind: 'contact' as const, id: String(c.contact.id), revision: c.revision }] : []),
    ]),
    ...work.snapshot.candidates.candidates.flatMap((c) => c.sourceRefs),
    ...(work.snapshot.candidates.verifiedLinks ?? []).flatMap((c) => c.sourceRefs),
    ...(work.snapshot.records ?? []).flatMap((r) => r.fields.flatMap((f) => f.sources)),
    ...(work.snapshot.deals ?? []).flatMap((r) => r.fields.flatMap((f) => f.sources)),
  ]);
}

function validate(
  analysis: AgentAnalysis,
  work: PreparedWork,
  resolution: ResolutionBundle,
  policy: AutomationPolicy,
): string[] {
  if (
    !preparedWorkSchema.safeParse(work).success ||
    !resolutionBundleSchema.safeParse(resolution).success ||
    !automationPolicySchema.safeParse(policy).success
  )
    return ['INVALID_PLANNER_INPUT'];
  if (policy.mode === 'disabled') return ['AUTOMATION_DISABLED'];
  if (work.catalogVersion !== work.snapshot.catalog.version) return ['CATALOG_VERSION_MISMATCH'];
  if (
    !work.coverage.complete ||
    work.coverage.missingReasons.length ||
    !work.snapshot.candidates.coverage.complete ||
    work.snapshot.candidates.coverage.missingReasons.length ||
    work.snapshot.conversations.some((c) => !c.coverage.complete || c.coverage.missingReasons.length)
  )
    return ['SNAPSHOT_COVERAGE_INCOMPLETE'];
  if (
    resolution.customer.kind === 'create' &&
    resolution.customer.proposal.kind === 'new' &&
    resolution.customer.proposal.entity === 'person' &&
    work.snapshot.conversations.length
  )
    return ['CHAT_PERSON_CREATION_REQUIRES_REVIEW'];
  if (resolution.customer.kind === 'review') return resolution.customer.reviewReasons;
  if (
    resolution.customer.customerId !== work.customerId ||
    (work.snapshot.candidates.customerId && work.snapshot.candidates.customerId !== work.customerId)
  )
    return ['CUSTOMER_ID_MISMATCH'];
  const sources = knownSources(work);
  if (
    [...resolution.customer.sourceRefs, ...resolution.demands.demands.flatMap((d) => d.sourceRefs)].some(
      (ref) => !sources.some((s) => sameSource(s, ref)),
    )
  )
    return ['RESOLUTION_SOURCE_UNVERIFIED'];
  const parsed = createAnalysisInputSchema({
    sourceRefs: sources.filter((s): s is SourceRef & { kind: 'message' | 'contact' | 'crm' } => s.kind !== 'operator'),
    candidates: work.snapshot.candidates.candidates.map((c) => c.ref),
    existingDemandIds: resolution.demands.demands.flatMap((d) => (d.kind === 'resolved' ? [d.demandId] : [])),
    catalog: work.snapshot.catalog,
    policy,
  }).safeParse({
    workId: work.workId,
    leaseToken: work.leaseToken,
    expectedSnapshotVersion: work.snapshotVersion,
    expectedContextVersion: work.contextVersion,
    analysis,
  });
  return parsed.success ? [] : ['ANALYSIS_EVIDENCE_INVALID'];
}

/** Decision summary for one request; missing commercial values do not prevent
 * an otherwise valid service request from becoming a deal. */
export function planDemand(
  analysis: AgentAnalysis,
  work: PreparedWork,
  resolution: ResolutionBundle,
  policy: AutomationPolicy,
  clientKey: string,
): PlannerDecision {
  const reviewReasons = validate(analysis, work, resolution, policy);
  return reviewReasons.length
    ? { canCreateDeal: false, pendingFields: [], commands: [], reviewReasons }
    : decideDemand(analysis, work, resolution, policy, clientKey);
}

function changedFacts(commands: MutationCommand[], resolution: ResolutionBundle): Fact[] {
  const after: Fact[] = [];
  for (const command of commands) {
    const entity = command.kind.endsWith('_organization')
      ? 'organization'
      : command.kind.endsWith('_person')
        ? 'person'
        : command.kind.endsWith('_deal')
          ? 'demand'
          : undefined;
    if (!entity) continue;
    const record = 'payload' in command ? command.payload : 'patch' in command ? command.patch : {};
    const demand =
      entity === 'demand'
        ? resolution.demands.demands.find(
            (d) => d.kind !== 'review' && [`deal:${d.demandId}`, `fields:${d.demandId}`].includes(command.commandKey),
          )
        : undefined;
    const add = (field: string, value: unknown) => {
      const candidate = factSchema.safeParse({
        entity,
        ...(demand ? { clientKey: demand.clientKey } : {}),
        field,
        value,
        certainty: 'confirmed',
        sources: command.sourceRefs,
      });
      if (candidate.success) after.push(candidate.data);
    };
    for (const [field, value] of Object.entries(record)) {
      if (field === 'contact' && value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value))
          if (key === 'email' || key === 'mobile') add(key === 'mobile' ? 'phone' : 'email', item);
      } else add(field, value);
    }
  }
  return after;
}

export function buildSyncPlan(
  analysis: AgentAnalysis,
  work: PreparedWork,
  resolution: ResolutionBundle,
  policy: AutomationPolicy,
): SyncPlan {
  const blocked = validate(analysis, work, resolution, policy);
  const commands: MutationCommand[] = [];
  const reviewReasons = [...blocked];
  const pendingFields: string[] = [];
  if (!blocked.length && resolution.customer.kind !== 'review') {
    const customer = resolution.customer;
    if (customer.kind === 'create') {
      const proposal = customer.proposal;
      if (proposal.kind !== 'new') throw new Error('Invalid server customer resolution');
      const facts = analysis.facts.filter((f) => f.entity === proposal.entity);
      const fields = buildFieldPatch({
        ref: { kind: proposal.entity, id: 1 },
        facts,
        current: [],
        catalog: work.snapshot.catalog,
        policy,
      });
      const record = (proposal.entity === 'organization' ? createOrganizationSchema : createPersonSchema).safeParse(
        fields.patch,
      );
      if (!record.success || record.data.name !== proposal.record.name || !policy.capabilities.includes('crm:create'))
        reviewReasons.push('CUSTOMER_CREATE_UNPROVEN');
      else
        commands.push({
          ...meta(`customer:${customer.customerId}`, fields.sourceRefs, 'crm:create'),
          kind: proposal.entity === 'organization' ? 'create_organization' : 'create_person',
          payload: record.data,
        } as MutationCommand);
      reviewReasons.push(...fields.reviewReasons);
    } else {
      const snapshot = work.snapshot.records?.find((record) => sameRef(record.ref, customer.ref));
      const facts = analysis.facts.filter((f) => f.entity === customer.ref.kind);
      if (facts.length && !snapshot) reviewReasons.push('CUSTOMER_FIELDS_SNAPSHOT_MISSING');
      else if (snapshot) {
        const fields = buildFieldPatch({
          ref: customer.ref,
          facts,
          current: snapshot.fields,
          lastWritten: snapshot.lastWritten,
          lockedFields: snapshot.lockedFields,
          catalog: work.snapshot.catalog,
          policy,
        });
        reviewReasons.push(...fields.reviewReasons);
        if (fields.patch && policy.capabilities.includes('crm:enrich'))
          commands.push({
            ...meta(`customer-fields:${customer.customerId}`, fields.sourceRefs, 'crm:enrich', snapshot.fields),
            kind: customer.ref.kind === 'organization' ? 'enrich_organization' : 'enrich_person',
            target: customer.ref,
            patch: fields.patch,
          } as MutationCommand);
      }
    }
    if (
      customer.kind !== 'create' ||
      commands.some((c) => c.kind === 'create_organization' || c.kind === 'create_person')
    ) {
      for (const demand of analysis.demands) {
        const decision = decideDemand(analysis, work, resolution, policy, demand.clientKey);
        commands.push(...decision.commands);
        reviewReasons.push(...decision.reviewReasons);
        pendingFields.push(...decision.pendingFields);
      }
    }
  }
  // Two analysis entries resolving to one server demand must never dispatch
  // duplicate POSTs. A duplicate key invalidates the affected plan.
  if (new Set(commands.map((c) => c.commandKey)).size !== commands.length) {
    commands.length = 0;
    reviewReasons.push('DUPLICATE_DEMAND_COMMAND');
  }
  if (commands.length > policy.limits.maxCommands || commands.length > 100) {
    commands.length = 0;
    reviewReasons.push('COMMAND_LIMIT');
  }
  const reasons = [...new Set(reviewReasons)].slice(0, 100);
  return syncPlanSchema.parse({
    planId: `plan:${work.workId}:${work.snapshotVersion}:${policy.version}`,
    version: 1,
    policyVersion: policy.version,
    workId: work.workId,
    analysisRevision: work.snapshotVersion,
    orderedCommands: commands,
    before: commands.flatMap((c) => c.before).slice(0, 500),
    after: changedFacts(commands, resolution).slice(0, 500),
    sourceRefs: uniqueSources(commands.flatMap((c) => c.sourceRefs)),
    reviewIds: [],
    pendingFields: [...new Set(pendingFields)].slice(0, 100),
    reviewReasons: reasons,
    state: commands.length ? 'ready' : reasons.length ? 'review' : 'noop',
  });
}
