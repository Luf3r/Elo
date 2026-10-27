import type { AgentAnalysis, PreparedWork, ResolutionBundle, AutomationPolicy, SyncPlan, PlannerDecision, SourceRef, Fact, MutationCommand, DealSnapshot, StageEvidence } from './types';
import { createAnalysisInputSchema, preparedWorkSchema, resolutionBundleSchema, syncPlanSchema, factSchema } from './schemas';
import { automationPolicySchema } from './policy-types';
import { createDealRecordSchema, createOrganizationSchema, createPersonSchema, createTaskRecordSchema } from '../agendor/crm/mutation-schemas';
import { buildFieldPatch, isActiveUser } from './fields';
import { decideStage } from './stages';
import { uniqueSources } from './identity';

const sameSource = (a: SourceRef, b: SourceRef) => a.kind === b.kind && a.id === b.id && a.revision === b.revision && a.field === b.field;
const sameRef = (a: { kind: string; id: number }, b: { kind: string; id: number }) => a.kind === b.kind && a.id === b.id;
function message(work: PreparedWork, source: SourceRef) {
  if (source.kind !== 'message') return;
  for (const conversation of work.snapshot.conversations) for (const entry of conversation.messages) {
    if (source.id === `${conversation.conversationId}:${entry.id}` && (work.snapshot.sourceRefs ? work.snapshot.sourceRefs.some(s => sameSource(s, source)) : source.revision === conversation.revision)) return entry;
  }
}
function knownSources(work: PreparedWork): SourceRef[] {
  if (work.snapshot.sourceRefs) return work.snapshot.sourceRefs;
  return uniqueSources([
    ...work.snapshot.conversations.flatMap(c => [
      ...c.messages.map(m => ({ kind: 'message' as const, id: `${c.conversationId}:${m.id}`, revision: c.revision })),
      ...(c.contact ? [{ kind: 'contact' as const, id: String(c.contact.id), revision: c.revision }] : []),
    ]),
    ...work.snapshot.candidates.candidates.flatMap(c => c.sourceRefs),
    ...(work.snapshot.candidates.verifiedLinks ?? []).flatMap(c => c.sourceRefs),
    ...(work.snapshot.records ?? []).flatMap(r => r.fields.flatMap(f => f.sources)),
    ...(work.snapshot.deals ?? []).flatMap(r => r.fields.flatMap(f => f.sources)),
  ]);
}
function validate(analysis: AgentAnalysis, work: PreparedWork, resolution: ResolutionBundle, policy: AutomationPolicy): string[] {
  if (!preparedWorkSchema.safeParse(work).success || !resolutionBundleSchema.safeParse(resolution).success || !automationPolicySchema.safeParse(policy).success) return ['INVALID_PLANNER_INPUT'];
  if (policy.mode === 'disabled') return ['AUTOMATION_DISABLED'];
  if (work.catalogVersion !== work.snapshot.catalog.version) return ['CATALOG_VERSION_MISMATCH'];
  if (!work.coverage.complete || work.coverage.missingReasons.length || !work.snapshot.candidates.coverage.complete || work.snapshot.candidates.coverage.missingReasons.length || work.snapshot.conversations.some(c => !c.coverage.complete || c.coverage.missingReasons.length)) return ['SNAPSHOT_COVERAGE_INCOMPLETE'];
  if (resolution.customer.kind === 'review') return resolution.customer.reviewReasons;
  if (resolution.customer.customerId !== work.customerId || (work.snapshot.candidates.customerId && work.snapshot.candidates.customerId !== work.customerId)) return ['CUSTOMER_ID_MISMATCH'];
  const sources = knownSources(work);
  if ([...resolution.customer.sourceRefs, ...resolution.demands.demands.flatMap(d => d.sourceRefs)].some(ref => !sources.some(s => sameSource(s, ref)))) return ['RESOLUTION_SOURCE_UNVERIFIED'];
  const parsed = createAnalysisInputSchema({ sourceRefs: sources.filter((s): s is SourceRef & { kind: 'message' | 'contact' | 'crm' } => s.kind !== 'operator'), candidates: work.snapshot.candidates.candidates.map(c => c.ref), existingDemandIds: resolution.demands.demands.flatMap(d => d.kind === 'resolved' ? [d.demandId] : []), catalog: work.snapshot.catalog, policy }).safeParse({ workId: work.workId, leaseToken: work.leaseToken, expectedSnapshotVersion: work.snapshotVersion, expectedContextVersion: work.contextVersion, analysis });
  return parsed.success ? [] : ['ANALYSIS_EVIDENCE_INVALID'];
}
const meta = (commandKey: string, sourceRefs: SourceRef[], capability: 'crm:create' | 'crm:enrich' | 'crm:write', before: Fact[] = [], dependencies: string[] = []) => ({ commandKey, dependencies, sourceRefs: uniqueSources(sourceRefs), before, requiredCapabilities: [capability] });

/** Resolve a structured relative date against its message, using the local
 * calendar. Conflicting anchors or timezone gaps remain pending. */
function commitmentDate(commitment: AgentAnalysis['demands'][number]['commitments'][number], work: PreparedWork): string | undefined {
  if (commitment.dueAt) return commitment.dueAt;
  if (!commitment.relativeDue) return;
  const timestamps = [...new Set(commitment.sources.map(s => message(work, s)?.createdAt))];
  if (timestamps.length !== 1 || timestamps[0] === undefined) return;
  const stamp = timestamps[0]; const anchor = new Date(stamp > 1e12 ? stamp : stamp * 1000);
  if (!Number.isFinite(anchor.getTime())) return;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Cuiaba', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = (date: Date) => Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]));
  const local = parts(anchor);
  const day = new Date(Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day) + commitment.relativeDue.days));
  const date = day.toISOString().slice(0, 10); const wall = Date.parse(`${date}T${commitment.relativeDue.time}:00Z`);
  const offsets: number[] = [];
  // Both sides of any historical offset transition must be considered. A gap
  // or repeated local time has zero or two solutions and is ambiguous.
  for (const hours of [-12, 12]) {
    const probe = new Date(wall + hours * 3600000); const p = parts(probe);
    const offset = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - Math.floor(probe.getTime() / 60000) * 60000;
    if (!offsets.includes(offset)) offsets.push(offset);
  }
  const valid = offsets.filter(offset => { const p = parts(new Date(wall - offset)); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` === `${date}T${commitment.relativeDue!.time}`; });
  if (valid.length !== 1) return;
  const minutes = valid[0]! / 60000; const sign = minutes < 0 ? '-' : '+'; const absolute = Math.abs(minutes);
  return `${date}T${commitment.relativeDue.time}:00${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

function decideDemand(analysis: AgentAnalysis, work: PreparedWork, resolution: ResolutionBundle, policy: AutomationPolicy, clientKey: string): PlannerDecision {
  const result: PlannerDecision = { canCreateDeal: false, pendingFields: [], commands: [], reviewReasons: [] };
  const demand = analysis.demands.find(d => d.clientKey === clientKey);
  const matches = resolution.demands.demands.filter(d => d.clientKey === clientKey);
  if (!demand || matches.length !== 1) { result.reviewReasons.push('DEMAND_RESOLUTION_MISSING'); return result; }
  const resolved = matches[0]!;
  if (resolved.kind === 'review' || resolved.reviewReasons.length) { result.reviewReasons.push(...resolved.reviewReasons); return result; }
  if (analysis.ambiguities.some(a => !a.clientKey || a.clientKey === clientKey)) { result.reviewReasons.push('DEMAND_AMBIGUOUS'); return result; }
  if (demand.approach.value === 'unknown') { result.pendingFields.push('approach'); result.reviewReasons.push('DEMAND_APPROACH_UNKNOWN'); return result; }
  if (!demand.explicitRequest.value && resolved.kind === 'create') { result.reviewReasons.push('EXPLICIT_REQUEST_REQUIRED'); return result; }
  const funnelId = policy.funnelMapping[demand.approach.value];
  if (!funnelId || !work.snapshot.catalog.funnels.some(f => f.id === funnelId)) { result.reviewReasons.push('FUNNEL_MAPPING_INVALID'); return result; }
  const snapshots = work.snapshot.deals?.filter(d => d.demandId === resolved.demandId) ?? [];
  if ((resolved.kind === 'resolved' && snapshots.length !== 1) || (resolved.kind === 'create' && snapshots.length)) { result.reviewReasons.push('DEAL_SNAPSHOT_MISMATCH'); return result; }
  const existing = snapshots[0];
  if (existing && existing.status !== 'open') { result.reviewReasons.push('DEAL_CLOSED'); return result; }
  const sourceRefs = uniqueSources([...demand.explicitRequest.sources, ...demand.approach.sources, ...demand.stage.sources, ...(demand.stage.observations ?? []).flatMap(o => o.sources)]);
  const evidence: StageEvidence = { demandId: resolved.demandId, requested: demand.stage.value, explicitRequest: demand.explicitRequest.value, approach: demand.approach.value, sourceRefs, catalog: work.snapshot.catalog, mapping: policy.stageMapping, funnelMapping: policy.funnelMapping,
    observations: (demand.stage.observations ?? []).map(o => ({ demandId: o.demandKey === clientKey ? resolved.demandId : o.demandKey, event: o.event, actor: o.actor,
      direction: o.sources.every(s => message(work, s)?.direction === 'outgoing' && ['user', 'agent', 'User'].includes(message(work, s)?.senderType ?? '')) ? 'outgoing' : o.sources.every(s => message(work, s)?.private === true && ['user', 'agent', 'User'].includes(message(work, s)?.senderType ?? '')) ? 'activity' : 'unknown', sources: o.sources })),
  };
  // An incoming message cannot become an internal team event by an actor claim.
  evidence.observations = evidence.observations?.filter(o => o.actor !== 'elotenant' || o.direction === 'outgoing' || o.direction === 'activity');
  let unassignedStageId = 1;
  while (work.snapshot.catalog.stages.some(stage => stage.id === unassignedStageId)) unassignedStageId++;
  const baseline: DealSnapshot = existing ?? { demandId: resolved.demandId, ref: { kind: 'deal', id: 1 }, revision: 'new', status: 'open', funnelId, stageId: unassignedStageId, stage: 'new_request', fields: [] };
  const stage = decideStage(evidence, baseline);
  result.reviewReasons.push(...stage.reviewReasons);
  if (!existing && (!stage.patch || stage.reviewReasons.length || !policy.capabilities.includes('crm:write'))) return result;
  const facts = analysis.facts.filter(f => f.entity === 'demand' && (f.clientKey === clientKey || (!f.clientKey && analysis.demands.length === 1)));
  if (analysis.facts.some(f => f.entity === 'demand' && !f.clientKey) && analysis.demands.length > 1) result.reviewReasons.push('DEMAND_FACT_SCOPE_REQUIRED');
  const description: Fact = { entity: 'demand', clientKey, field: 'description', value: `${demand.service}\n${demand.scope}`, certainty: 'confirmed', sources: demand.explicitRequest.sources };
  const fields = buildFieldPatch({ ref: baseline.ref, facts: [...facts.filter(f => f.field !== 'description'), ...(facts.some(f => f.field === 'description') ? facts.filter(f => f.field === 'description') : [description])], current: baseline.fields, catalog: work.snapshot.catalog, policy, lastWritten: existing?.lastWritten, lockedFields: existing?.lockedFields });
  result.reviewReasons.push(...fields.reviewReasons);
  if (!facts.some(f => f.field === 'value' && f.certainty === 'confirmed' && typeof f.value === 'number') && !baseline.fields.some(f => f.field === 'value' && typeof f.value === 'number')) result.pendingFields.push('value');
  if (demand.items.length) result.pendingFields.push('products_entities');
  if (facts.some(f => f.field.startsWith('customFields.'))) result.pendingFields.push('customFields');
  if (!facts.some(f => f.field === 'ownerUser') && !baseline.fields.some(f => f.field === 'ownerUser')) result.pendingFields.push('ownerUser');
  const dealKey = `deal:${resolved.demandId}`; const stageKey = `stage:${resolved.demandId}`;
  const target = existing?.ref ?? { kind: 'deal' as const, commandKey: dealKey };
  const dependencies = existing ? [] : [dealKey];
  if (!existing) {
    if (resolution.customer.kind === 'review' || !policy.capabilities.includes('crm:create')) { result.reviewReasons.push('CREATE_DISABLED'); return result; }
    const customer = resolution.customer;
    const parent = customer.kind === 'resolved' ? customer.ref : { kind: customer.proposal.kind === 'new' ? customer.proposal.entity : 'organization' as const, commandKey: `customer:${customer.customerId}` };
    const record = createDealRecordSchema.safeParse({ title: demand.service, ...fields.patch });
    if (!record.success) { result.reviewReasons.push('DEAL_RECORD_INVALID'); return result; }
    result.canCreateDeal = true;
    result.commands.push({ ...meta(dealKey, [...sourceRefs, ...fields.sourceRefs], 'crm:create', [], 'commandKey' in parent ? [parent.commandKey] : []), kind: 'create_deal', target: parent, payload: record.data });
  } else if (fields.patch && policy.capabilities.includes('crm:enrich')) {
    result.commands.push({ ...meta(`fields:${resolved.demandId}`, fields.sourceRefs, 'crm:enrich', baseline.fields), kind: 'enrich_deal', target: existing.ref, patch: fields.patch });
  }
  if (stage.patch && policy.capabilities.includes('crm:write')) result.commands.push({ ...meta(stageKey, stage.sourceRefs, 'crm:write', baseline.fields, dependencies), kind: 'change_stage', target, patch: stage.patch });
  for (const [index, commitment] of demand.commitments.entries()) {
    const due_date = commitmentDate(commitment, work);
    if (!commitment.type || !isActiveUser(work.snapshot.catalog, commitment.assignedUserId) || !due_date || !policy.capabilities.includes('crm:create')) { result.pendingFields.push('commitments'); continue; }
    const payload = createTaskRecordSchema.safeParse({ text: commitment.text, type: commitment.type, assigned_users: [commitment.assignedUserId], due_date });
    if (!payload.success) { result.pendingFields.push('commitments'); continue; }
    result.commands.push({ ...meta(`task:${resolved.demandId}:${index}`, commitment.sources, 'crm:create', [], [...dependencies, ...(stage.patch && policy.capabilities.includes('crm:write') ? [stageKey] : [])]), kind: 'create_task', target, payload: payload.data });
  }
  result.pendingFields = [...new Set(result.pendingFields)]; result.reviewReasons = [...new Set(result.reviewReasons)];
  return result;
}

/** Decision summary for one request; missing commercial values do not prevent
 * an otherwise valid service request from becoming a deal. */
export function planDemand(analysis: AgentAnalysis, work: PreparedWork, resolution: ResolutionBundle, policy: AutomationPolicy, clientKey: string): PlannerDecision {
  const reviewReasons = validate(analysis, work, resolution, policy);
  return reviewReasons.length ? { canCreateDeal: false, pendingFields: [], commands: [], reviewReasons } : decideDemand(analysis, work, resolution, policy, clientKey);
}

function changedFacts(commands: MutationCommand[], resolution: ResolutionBundle): Fact[] {
  const after: Fact[] = [];
  for (const command of commands) {
    const entity = command.kind.endsWith('_organization') ? 'organization' : command.kind.endsWith('_person') ? 'person' : command.kind.endsWith('_deal') ? 'demand' : undefined;
    if (!entity) continue;
    const record = 'payload' in command ? command.payload : 'patch' in command ? command.patch : {};
    const demand = entity === 'demand' ? resolution.demands.demands.find(d => d.kind !== 'review' && [
      `deal:${d.demandId}`, `fields:${d.demandId}`,
    ].includes(command.commandKey)) : undefined;
    const add = (field: string, value: unknown) => {
      const candidate = factSchema.safeParse({ entity, ...(demand ? { clientKey: demand.clientKey } : {}), field, value, certainty: 'confirmed', sources: command.sourceRefs });
      if (candidate.success) after.push(candidate.data);
    };
    for (const [field, value] of Object.entries(record)) {
      if (field === 'contact' && value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) if (key === 'email' || key === 'mobile') add(key === 'mobile' ? 'phone' : 'email', item);
      } else add(field, value);
    }
  }
  return after;
}

export function buildSyncPlan(analysis: AgentAnalysis, work: PreparedWork, resolution: ResolutionBundle, policy: AutomationPolicy): SyncPlan {
  const blocked = validate(analysis, work, resolution, policy);
  const commands: MutationCommand[] = []; const reviewReasons = [...blocked]; const pendingFields: string[] = [];
  if (!blocked.length && resolution.customer.kind !== 'review') {
    const customer = resolution.customer;
    if (customer.kind === 'create') {
      const proposal = customer.proposal;
      if (proposal.kind !== 'new') throw new Error('Invalid server customer resolution');
      const facts = analysis.facts.filter(f => f.entity === proposal.entity);
      const fields = buildFieldPatch({ ref: { kind: proposal.entity, id: 1 }, facts, current: [], catalog: work.snapshot.catalog, policy });
      const record = (proposal.entity === 'organization' ? createOrganizationSchema : createPersonSchema).safeParse(fields.patch);
      if (!record.success || record.data.name !== proposal.record.name || !policy.capabilities.includes('crm:create')) reviewReasons.push('CUSTOMER_CREATE_UNPROVEN');
      else commands.push({ ...meta(`customer:${customer.customerId}`, fields.sourceRefs, 'crm:create'), kind: proposal.entity === 'organization' ? 'create_organization' : 'create_person', payload: record.data } as MutationCommand);
      reviewReasons.push(...fields.reviewReasons);
    } else {
      const snapshot = work.snapshot.records?.find(record => sameRef(record.ref, customer.ref));
      const facts = analysis.facts.filter(f => f.entity === customer.ref.kind);
      if (facts.length && !snapshot) reviewReasons.push('CUSTOMER_FIELDS_SNAPSHOT_MISSING');
      else if (snapshot) {
        const fields = buildFieldPatch({ ref: customer.ref, facts, current: snapshot.fields, lastWritten: snapshot.lastWritten, lockedFields: snapshot.lockedFields, catalog: work.snapshot.catalog, policy });
        reviewReasons.push(...fields.reviewReasons);
        if (fields.patch && policy.capabilities.includes('crm:enrich')) commands.push({ ...meta(`customer-fields:${customer.customerId}`, fields.sourceRefs, 'crm:enrich', snapshot.fields), kind: customer.ref.kind === 'organization' ? 'enrich_organization' : 'enrich_person', target: customer.ref, patch: fields.patch } as MutationCommand);
      }
    }
    if (customer.kind !== 'create' || commands.some(c => c.kind === 'create_organization' || c.kind === 'create_person')) {
      for (const demand of analysis.demands) {
        const decision = decideDemand(analysis, work, resolution, policy, demand.clientKey);
        commands.push(...decision.commands); reviewReasons.push(...decision.reviewReasons); pendingFields.push(...decision.pendingFields);
      }
    }
  }
  // Two analysis entries resolving to one server demand must never dispatch
  // duplicate POSTs. A duplicate key invalidates the affected plan.
  if (new Set(commands.map(c => c.commandKey)).size !== commands.length) { commands.length = 0; reviewReasons.push('DUPLICATE_DEMAND_COMMAND'); }
  if (commands.length > policy.limits.maxCommands || commands.length > 100) { commands.length = 0; reviewReasons.push('COMMAND_LIMIT'); }
  const reasons = [...new Set(reviewReasons)].slice(0, 100);
  return syncPlanSchema.parse({ planId: `plan:${work.workId}:${work.snapshotVersion}:${policy.version}`, version: 1, policyVersion: policy.version, workId: work.workId, analysisRevision: work.snapshotVersion,
    orderedCommands: commands, before: commands.flatMap(c => c.before).slice(0, 500), after: changedFacts(commands, resolution).slice(0, 500), sourceRefs: uniqueSources(commands.flatMap(c => c.sourceRefs)),
    reviewIds: [], pendingFields: [...new Set(pendingFields)].slice(0, 100), reviewReasons: reasons, state: commands.length ? 'ready' : reasons.length ? 'review' : 'noop' });
}
