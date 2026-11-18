import { createDealRecordSchema, createTaskRecordSchema } from '../shared/contracts/crm-mutations';
import type { AutomationPolicy } from './policy-types';
import type { AgentAnalysis } from './schemas/analysis';
import type { Fact, SourceRef } from './schemas/common';
import type { MutationCommand, PlannerDecision, ResolutionBundle, StageEvidence } from './schemas/planning';
import type { DealSnapshot, PreparedWork } from './schemas/snapshot';
import { buildFieldPatch, isActiveUser } from './fields';
import { decideStage } from './stages';
import { uniqueSources } from './identity';

export const sameSource = (a: SourceRef, b: SourceRef) =>
  a.kind === b.kind && a.id === b.id && a.revision === b.revision && a.field === b.field;

export function message(work: PreparedWork, source: SourceRef) {
  if (source.kind !== 'message') return;
  for (const conversation of work.snapshot.conversations)
    for (const entry of conversation.messages) {
      if (
        source.id === `${conversation.conversationId}:${entry.id}` &&
        (work.snapshot.sourceRefs
          ? work.snapshot.sourceRefs.some((s) => sameSource(s, source))
          : source.revision === conversation.revision)
      )
        return entry;
    }
}

export const meta = (
  commandKey: string,
  sourceRefs: SourceRef[],
  capability: 'crm:create' | 'crm:enrich' | 'crm:write',
  before: Fact[] = [],
  dependencies: string[] = [],
) => ({ commandKey, dependencies, sourceRefs: uniqueSources(sourceRefs), before, requiredCapabilities: [capability] });

/** Resolve a structured relative date against its message, using the local
 * calendar. Conflicting anchors or timezone gaps remain pending. */
function commitmentDate(
  commitment: AgentAnalysis['demands'][number]['commitments'][number],
  work: PreparedWork,
): string | undefined {
  if (commitment.dueAt) return commitment.dueAt;
  if (!commitment.relativeDue) return;
  const timestamps = [...new Set(commitment.sources.map((s) => message(work, s)?.createdAt))];
  if (timestamps.length !== 1 || timestamps[0] === undefined) return;
  const stamp = timestamps[0];
  const anchor = new Date(stamp > 1e12 ? stamp : stamp * 1000);
  if (!Number.isFinite(anchor.getTime())) return;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Cuiaba',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = (date: Date) => Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  const local = parts(anchor);
  const day = new Date(
    Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day) + commitment.relativeDue.days),
  );
  const date = day.toISOString().slice(0, 10);
  const wall = Date.parse(`${date}T${commitment.relativeDue.time}:00Z`);
  const offsets: number[] = [];
  // Both sides of any historical offset transition must be considered. A gap
  // or repeated local time has zero or two solutions and is ambiguous.
  for (const hours of [-12, 12]) {
    const probe = new Date(wall + hours * 3600000);
    const p = parts(probe);
    const offset =
      Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) -
      Math.floor(probe.getTime() / 60000) * 60000;
    if (!offsets.includes(offset)) offsets.push(offset);
  }
  const valid = offsets.filter((offset) => {
    const p = parts(new Date(wall - offset));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` === `${date}T${commitment.relativeDue!.time}`;
  });
  if (valid.length !== 1) return;
  const minutes = valid[0]! / 60000;
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `${date}T${commitment.relativeDue.time}:00${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

export function decideDemand(
  analysis: AgentAnalysis,
  work: PreparedWork,
  resolution: ResolutionBundle,
  policy: AutomationPolicy,
  clientKey: string,
): PlannerDecision {
  const result: PlannerDecision = { canCreateDeal: false, pendingFields: [], commands: [], reviewReasons: [] };
  const demand = analysis.demands.find((d) => d.clientKey === clientKey);
  const matches = resolution.demands.demands.filter((d) => d.clientKey === clientKey);
  if (!demand || matches.length !== 1) {
    result.reviewReasons.push('DEMAND_RESOLUTION_MISSING');
    return result;
  }
  const resolved = matches[0]!;
  if (resolved.kind === 'review' || resolved.reviewReasons.length) {
    result.reviewReasons.push(...resolved.reviewReasons);
    return result;
  }
  if (analysis.ambiguities.some((a) => !a.clientKey || a.clientKey === clientKey)) {
    result.reviewReasons.push('DEMAND_AMBIGUOUS');
    return result;
  }
  if (demand.approach.value === 'unknown') {
    result.pendingFields.push('approach');
    result.reviewReasons.push('DEMAND_APPROACH_UNKNOWN');
    return result;
  }
  if (!demand.explicitRequest.value && resolved.kind === 'create') {
    result.reviewReasons.push('EXPLICIT_REQUEST_REQUIRED');
    return result;
  }
  const funnelId = policy.funnelMapping[demand.approach.value];
  if (!funnelId || !work.snapshot.catalog.funnels.some((f) => f.id === funnelId)) {
    result.reviewReasons.push('FUNNEL_MAPPING_INVALID');
    return result;
  }
  const snapshots = work.snapshot.deals?.filter((d) => d.demandId === resolved.demandId) ?? [];
  if ((resolved.kind === 'resolved' && snapshots.length !== 1) || (resolved.kind === 'create' && snapshots.length)) {
    result.reviewReasons.push('DEAL_SNAPSHOT_MISMATCH');
    return result;
  }
  const existing = snapshots[0];
  if (existing && existing.status !== 'open') {
    result.reviewReasons.push('DEAL_CLOSED');
    return result;
  }
  const sourceRefs = uniqueSources([
    ...demand.explicitRequest.sources,
    ...demand.approach.sources,
    ...demand.stage.sources,
    ...(demand.stage.observations ?? []).flatMap((o) => o.sources),
  ]);
  const evidence: StageEvidence = {
    demandId: resolved.demandId,
    requested: demand.stage.value,
    explicitRequest: demand.explicitRequest.value,
    approach: demand.approach.value,
    sourceRefs,
    catalog: work.snapshot.catalog,
    mapping: policy.stageMapping,
    funnelMapping: policy.funnelMapping,
    observations: (demand.stage.observations ?? []).map((o) => ({
      demandId: o.demandKey === clientKey ? resolved.demandId : o.demandKey,
      event: o.event,
      actor: o.actor,
      direction: o.sources.every(
        (s) =>
          message(work, s)?.direction === 'outgoing' &&
          ['user', 'agent', 'User'].includes(message(work, s)?.senderType ?? ''),
      )
        ? 'outgoing'
        : o.sources.every(
              (s) =>
                message(work, s)?.private === true &&
                ['user', 'agent', 'User'].includes(message(work, s)?.senderType ?? ''),
            )
          ? 'activity'
          : 'unknown',
      sources: o.sources,
    })),
  };
  // An incoming message cannot become an internal team event by an actor claim.
  evidence.observations = evidence.observations?.filter(
    (o) => o.actor !== 'elotenant' || o.direction === 'outgoing' || o.direction === 'activity',
  );
  let unassignedStageId = 1;
  while (work.snapshot.catalog.stages.some((stage) => stage.id === unassignedStageId)) unassignedStageId++;
  const baseline: DealSnapshot = existing ?? {
    demandId: resolved.demandId,
    ref: { kind: 'deal', id: 1 },
    revision: 'new',
    status: 'open',
    funnelId,
    stageId: unassignedStageId,
    stage: 'new_request',
    fields: [],
  };
  const stage = decideStage(evidence, baseline);
  result.reviewReasons.push(...stage.reviewReasons);
  if (!existing && (!stage.patch || stage.reviewReasons.length || !policy.capabilities.includes('crm:write')))
    return result;
  const facts = analysis.facts.filter(
    (f) => f.entity === 'demand' && (f.clientKey === clientKey || (!f.clientKey && analysis.demands.length === 1)),
  );
  if (analysis.facts.some((f) => f.entity === 'demand' && !f.clientKey) && analysis.demands.length > 1)
    result.reviewReasons.push('DEMAND_FACT_SCOPE_REQUIRED');
  const description: Fact = {
    entity: 'demand',
    clientKey,
    field: 'description',
    value: `${demand.service}\n${demand.scope}`,
    certainty: 'confirmed',
    sources: demand.explicitRequest.sources,
  };
  const fields = buildFieldPatch({
    ref: baseline.ref,
    facts: [
      ...facts.filter((f) => f.field !== 'description'),
      ...(facts.some((f) => f.field === 'description')
        ? facts.filter((f) => f.field === 'description')
        : [description]),
    ],
    current: baseline.fields,
    catalog: work.snapshot.catalog,
    policy,
    lastWritten: existing?.lastWritten,
    lockedFields: existing?.lockedFields,
  });
  result.reviewReasons.push(...fields.reviewReasons);
  if (
    !facts.some((f) => f.field === 'value' && f.certainty === 'confirmed' && typeof f.value === 'number') &&
    !baseline.fields.some((f) => f.field === 'value' && typeof f.value === 'number')
  )
    result.pendingFields.push('value');
  if (demand.items.length) result.pendingFields.push('products_entities');
  if (facts.some((f) => f.field.startsWith('customFields.'))) result.pendingFields.push('customFields');
  if (!facts.some((f) => f.field === 'ownerUser') && !baseline.fields.some((f) => f.field === 'ownerUser'))
    result.pendingFields.push('ownerUser');
  const dealKey = `deal:${resolved.demandId}`;
  const stageKey = `stage:${resolved.demandId}`;
  const target = existing?.ref ?? { kind: 'deal' as const, commandKey: dealKey };
  const dependencies = existing ? [] : [dealKey];
  if (!existing) {
    if (resolution.customer.kind === 'review' || !policy.capabilities.includes('crm:create')) {
      result.reviewReasons.push('CREATE_DISABLED');
      return result;
    }
    const customer = resolution.customer;
    const parent =
      customer.kind === 'resolved'
        ? customer.ref
        : {
            kind: customer.proposal.kind === 'new' ? customer.proposal.entity : ('organization' as const),
            commandKey: `customer:${customer.customerId}`,
          };
    const record = createDealRecordSchema.safeParse({ title: demand.service, ...fields.patch });
    if (!record.success) {
      result.reviewReasons.push('DEAL_RECORD_INVALID');
      return result;
    }
    result.canCreateDeal = true;
    result.commands.push({
      ...meta(
        dealKey,
        [...sourceRefs, ...fields.sourceRefs],
        'crm:create',
        [],
        'commandKey' in parent ? [parent.commandKey] : [],
      ),
      kind: 'create_deal',
      target: parent,
      payload: record.data,
    });
  } else if (fields.patch && policy.capabilities.includes('crm:enrich')) {
    result.commands.push({
      ...meta(`fields:${resolved.demandId}`, fields.sourceRefs, 'crm:enrich', baseline.fields),
      kind: 'enrich_deal',
      target: existing.ref,
      patch: fields.patch,
    });
  }
  if (stage.patch && policy.capabilities.includes('crm:write'))
    result.commands.push({
      ...meta(stageKey, stage.sourceRefs, 'crm:write', baseline.fields, dependencies),
      kind: 'change_stage',
      target,
      patch: stage.patch,
    });
  for (const [index, commitment] of demand.commitments.entries()) {
    const due_date = commitmentDate(commitment, work);
    if (
      !commitment.type ||
      !isActiveUser(work.snapshot.catalog, commitment.assignedUserId) ||
      !due_date ||
      !policy.capabilities.includes('crm:create')
    ) {
      result.pendingFields.push('commitments');
      continue;
    }
    const payload = createTaskRecordSchema.safeParse({
      text: commitment.text,
      type: commitment.type,
      assigned_users: [commitment.assignedUserId],
      due_date,
    });
    if (!payload.success) {
      result.pendingFields.push('commitments');
      continue;
    }
    result.commands.push({
      ...meta(
        `task:${resolved.demandId}:${index}`,
        commitment.sources,
        'crm:create',
        [],
        [...dependencies, ...(stage.patch && policy.capabilities.includes('crm:write') ? [stageKey] : [])],
      ),
      kind: 'create_task',
      target,
      payload: payload.data,
    });
  }
  result.pendingFields = [...new Set(result.pendingFields)];
  result.reviewReasons = [...new Set(result.reviewReasons)];
  return result;
}
