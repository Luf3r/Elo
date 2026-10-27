import { z } from 'zod';
import type { CatalogSnapshot } from '../agendor/crm/types';
import type { ConversationSnapshot, Coverage } from '../agendor/chat/types';
import { positiveId, updateOrganizationInput, updatePersonInput, updateDealInput, updateDealStageInput } from '../agendor/crm/schemas';
import { crmIdSchema, entityRefSchema, taskParentSchema, customFieldValueSchema, customFieldMatchesCatalog, createOrganizationSchema, createPersonSchema, createDealRecordSchema, createTaskRecordSchema, enrichOrganizationSchema, enrichPersonSchema, enrichDealSchema, updateTaskSchema, changeStageSchema } from '../agendor/crm/mutation-schemas';
import { automationPolicySchema, capabilitySchema, stageKeySchema } from './policy-types';
export { entityRefSchema, taskParentSchema, stageKeySchema };
const key = z.string().trim().min(1).max(200).refine(v => !['__proto__', 'prototype', 'constructor'].includes(v));
const version = positiveId;
const date = z.iso.datetime({ offset: true });
const safeField = z.string().min(1).max(150).refine(v => !v.split('.').some(p => ['__proto__', 'prototype', 'constructor'].includes(p)));
export const sourceRefSchema = z.strictObject({ kind: z.enum(['message', 'contact', 'crm', 'operator']), id: key, revision: key, field: safeField.optional() });
// This schema is the public submission boundary. Operator sources exist only in
// backend review/plan contracts, never in an agent-supplied analysis.
export const submittedSourceRefSchema = sourceRefSchema.extend({ kind: z.enum(['message', 'contact', 'crm']) });
const sources = z.array(submittedSourceRefSchema).min(1).max(100);
const internalSources = z.array(sourceRefSchema).max(1000);
export const factValueSchema = customFieldValueSchema;
const factFields = {
  organization: new Set(['name', 'legalName', 'cnpj', 'email', 'phone', 'website', 'description', 'ranking', 'leadOrigin', 'category', 'sector']),
  person: new Set(['name', 'role', 'email', 'phone', 'organization', 'description', 'birthday', 'ranking']),
  demand: new Set(['service', 'scope', 'title', 'description', 'value', 'startTime', 'ownerUser']),
};
const factObject = z.strictObject({ entity: z.enum(['organization', 'person', 'demand']), clientKey: key.optional(), field: safeField, value: factValueSchema, sources: internalSources.min(1), certainty: z.enum(['confirmed', 'ambiguous']) });
const allowedFactField = (v: z.infer<typeof factObject>) => factFields[v.entity].has(v.field) || /^customFields\.[a-zA-Z0-9_-]+$/.test(v.field);
export const factSchema = factObject.refine(allowedFactField, 'Unsupported fact field.');
export const submittedFactSchema = factObject.extend({ sources }).refine(allowedFactField, 'Unsupported fact field.');
export const reviewDecisionSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('selectCustomer'), ref: entityRefSchema }), z.strictObject({ kind: z.literal('selectDemand'), demandId: key }), z.strictObject({ kind: z.literal('correctFacts'), facts: z.array(submittedFactSchema).min(1).max(500) }), z.strictObject({ kind: z.literal('approvePlan'), planId: key, planVersion: version }), z.strictObject({ kind: z.literal('reject'), reason: z.string().min(1).max(2000) })]);
const selectionSchema = z.union([entityRefSchema,
  z.strictObject({ kind: z.literal('new'), entity: z.literal('organization'), record: createOrganizationSchema }),
  z.strictObject({ kind: z.literal('new'), entity: z.literal('person'), record: createPersonSchema }),
]);
const approachSchema = z.strictObject({ value: z.enum(['client', 'elotenant', 'unknown']), sources });
const stageEvent = z.enum(['request', 'preparation', 'internal_approval_pending', 'internal_approval_completed', 'proposal_sent', 'future_send', 'client_approval', 'proposal_received']);
const stageActor = z.enum(['elotenant', 'client', 'third_party', 'unknown']);
const stageObservation = z.strictObject({ demandKey: key, event: stageEvent, actor: stageActor, sources });
const stageEvidenceSchema = z.strictObject({ value: stageKeySchema, sources, observations: z.array(stageObservation).max(100).optional() });
const itemSchema = z.strictObject({ productId: crmIdSchema, quantity: z.number().finite().positive(), unitValue: z.number().finite().min(0).max(1_000_000_000_000).optional(), unit: z.string().min(1).max(80).optional(), discount: z.number().finite().min(0).max(100).optional(), sources });
const commitmentSchema = z.strictObject({ text: z.string().min(1).max(2000), dueAt: date.optional(), relativeDue: z.strictObject({ days: z.number().int().min(0).max(366), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) }).optional(), type: createTaskRecordSchema.shape.type.optional(), assignedUserId: crmIdSchema.optional(), sources }).refine(v => (v.dueAt !== undefined) !== (v.relativeDue !== undefined), 'Provide one explicit due date or relative date.');
const demandReferenceSchema = z.strictObject({ kind: z.enum(['order', 'proposal', 'project']), value: key, sources });
export const demandAnalysisSchema = z.strictObject({ clientKey: key, existingDemandId: key.optional(), references: z.array(demandReferenceSchema).max(100).optional(), service: z.string().min(1).max(300), scope: z.string().min(1).max(2000), explicitRequest: z.strictObject({ value: z.boolean(), sources }), approach: approachSchema, stage: stageEvidenceSchema, items: z.array(itemSchema).max(100), commitments: z.array(commitmentSchema).max(100) });
export const ambiguitySchema = z.strictObject({ code: key, description: z.string().min(1).max(2000), sources, clientKey: key.optional() });
export const agentAnalysisSchema = z.strictObject({ customerSelection: selectionSchema, facts: z.array(submittedFactSchema).max(500), demands: z.array(demandAnalysisSchema).max(100), ambiguities: z.array(ambiguitySchema).max(100) }).refine(v => new Set(v.demands.map(d => d.clientKey)).size === v.demands.length, 'Duplicate demand clientKey.');
export const workTargetSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('conversation'), conversationId: positiveId }), z.strictObject({ kind: z.literal('customer'), customerId: key }), z.strictObject({ kind: z.literal('pending') })]);
export const prepareInputSchema = z.union([z.strictObject({ requestId: key, target: workTargetSchema, mode: z.enum(['preview', 'apply']) }), z.strictObject({ requestId: key, workId: key, leaseToken: key, continuation: key })]);
export const analysisInputSchema = z.strictObject({ workId: key, leaseToken: key, expectedSnapshotVersion: version, expectedContextVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), analysis: agentAnalysisSchema });
export type AnalysisValidationContext = { sourceRefs: z.infer<typeof submittedSourceRefSchema>[]; candidates: z.infer<typeof entityRefSchema>[]; existingDemandIds: string[]; catalog: CatalogSnapshot; policy?: z.infer<typeof automationPolicySchema> };
/** Bind this to the persisted work, never to a manifest supplied by the agent. */
export function createAnalysisInputSchema(context: AnalysisValidationContext) {
  return analysisInputSchema.superRefine((input, ctx) => {
    const reject = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    const knownEntity = (kind: string, id: number) => context.candidates.some(c => c.kind === kind && c.id === id);
    const selection = input.analysis.customerSelection;
    if (selection.kind !== 'new' && !knownEntity(selection.kind, selection.id)) reject(['analysis', 'customerSelection'], 'Selection absent from snapshot.');
    if (selection.kind === 'new' && selection.entity === 'person' && selection.record.organization !== undefined && !knownEntity('organization', selection.record.organization)) reject(['analysis', 'customerSelection'], 'Organization absent from snapshot.');
    // Traverse only schema-parsed structures; user objects cannot contribute extra keys.
    const checkSources = (value: unknown, path: (string | number)[]) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach((v, i) => checkSources(v, [...path, i])); return; }
      for (const [field, child] of Object.entries(value)) {
        if (field === 'sources' && Array.isArray(child)) child.forEach((ref: z.infer<typeof submittedSourceRefSchema>, i) => {
          if (!context.sourceRefs.some(s => s.kind === ref.kind && s.id === ref.id && s.revision === ref.revision && s.field === ref.field)) reject([...path, field, i], 'Source absent or stale in snapshot.');
        }); else checkSources(child, [...path, field]);
      }
    };
    checkSources(input.analysis, ['analysis']);
    input.analysis.facts.forEach((fact, i) => {
      if (fact.clientKey !== undefined && (fact.entity !== 'demand' || !input.analysis.demands.some(d => d.clientKey === fact.clientKey))) reject(['analysis', 'facts', i], 'Fact demand absent from analysis.');
      if (fact.entity === 'person' && fact.field === 'organization' && (!crmIdSchema.safeParse(fact.value).success || !knownEntity('organization', fact.value as number))) reject(['analysis', 'facts', i], 'Organization absent from snapshot.');
      if (fact.field === 'ownerUser' && !context.catalog.users.some(u => u.id === fact.value)) reject(['analysis', 'facts', i], 'User absent from catalog.');
      if (fact.field.startsWith('customFields.')) {
        const entity = { organization: 'organizations', person: 'people', demand: 'deals' } as const;
        const logical = fact.field.slice(13);
        const mappings = context.policy?.customFieldMapping.filter(m => m.entity === entity[fact.entity] && m.field === logical) ?? [];
        const id = mappings.length === 1 ? mappings[0]!.catalogFieldId : logical;
        if (mappings.length > 1 || !customFieldMatchesCatalog({ id, value: fact.value }, entity[fact.entity], context.catalog)) reject(['analysis', 'facts', i], 'Invalid catalog field.');
      }
    });
    if (selection.kind === 'new') for (const f of selection.record.customFields ?? []) if (!customFieldMatchesCatalog(f, selection.entity === 'person' ? 'people' : 'organizations', context.catalog)) reject(['analysis', 'customerSelection'], 'Invalid catalog field.');
    input.analysis.demands.forEach((d, i) => {
      d.stage.observations?.forEach((observation, j) => { if (observation.demandKey !== d.clientKey) reject(['analysis', 'demands', i, 'stage', 'observations', j], 'Stage evidence belongs to another demand.'); });
      if (d.existingDemandId && !context.existingDemandIds.includes(d.existingDemandId)) reject(['analysis', 'demands', i, 'existingDemandId'], 'Demand absent from work.');
      d.items.forEach((item, j) => { if (!context.catalog.products.some(p => p.id === item.productId)) reject(['analysis', 'demands', i, 'items', j], 'Product absent from catalog.'); });
      d.commitments.forEach((c, j) => { if (c.assignedUserId !== undefined && !context.catalog.users.some(u => u.id === c.assignedUserId)) reject(['analysis', 'demands', i, 'commitments', j], 'User absent from catalog.'); });
    });
  });
}

export const crmRefSchema = taskParentSchema;
export const commandTargetSchema = z.union([taskParentSchema, z.strictObject({ kind: z.enum(['organization', 'person', 'deal']), commandKey: key })]);
const commandMeta = { commandKey: key, dependencies: z.array(key).max(100), before: z.array(factSchema).max(500), sourceRefs: internalSources.min(1), requiredCapabilities: z.array(capabilitySchema).min(1).max(8) };
const existingOrganization = z.strictObject({ kind: z.literal('organization'), id: crmIdSchema });
const existingPerson = z.strictObject({ kind: z.literal('person'), id: crmIdSchema });
const existingDeal = z.strictObject({ kind: z.literal('deal'), id: crmIdSchema });
export const mutationCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...commandMeta, kind: z.literal('legacy_update_organization'), target: existingOrganization, patch: updateOrganizationInput }),
  z.strictObject({ ...commandMeta, kind: z.literal('legacy_update_person'), target: existingPerson, patch: updatePersonInput }),
  z.strictObject({ ...commandMeta, kind: z.literal('legacy_update_deal'), target: existingDeal, patch: updateDealInput }),
  z.strictObject({ ...commandMeta, kind: z.literal('legacy_update_stage'), target: existingDeal, patch: updateDealStageInput }),
  z.strictObject({ ...commandMeta, kind: z.literal('create_organization'), payload: createOrganizationSchema }),
  z.strictObject({ ...commandMeta, kind: z.literal('create_person'), target: z.union([existingOrganization, z.strictObject({ kind: z.literal('organization'), commandKey: key })]).optional(), payload: createPersonSchema }).refine(v => !v.target || v.payload.organization === undefined, 'Use one explicit organization link.'),
  z.strictObject({ ...commandMeta, kind: z.literal('create_deal'), target: commandTargetSchema, payload: createDealRecordSchema }).refine(v => v.target.kind !== 'deal', 'Deal requires one company/person parent.'),
  z.strictObject({ ...commandMeta, kind: z.literal('create_task'), target: commandTargetSchema, payload: createTaskRecordSchema }),
  z.strictObject({ ...commandMeta, kind: z.literal('enrich_organization'), target: existingOrganization, patch: enrichOrganizationSchema }),
  z.strictObject({ ...commandMeta, kind: z.literal('enrich_person'), target: existingPerson, patch: enrichPersonSchema }),
  z.strictObject({ ...commandMeta, kind: z.literal('enrich_deal'), target: existingDeal, patch: enrichDealSchema }),
  z.strictObject({ ...commandMeta, kind: z.literal('update_task'), target: z.strictObject({ kind: z.literal('task'), id: crmIdSchema }), patch: updateTaskSchema }),
  z.strictObject({ ...commandMeta, kind: z.literal('change_stage'), target: z.union([existingDeal, z.strictObject({ kind: z.literal('deal'), commandKey: key })]), patch: changeStageSchema }),
]);
export const syncPlanSchema = z.strictObject({ planId: key, version, policyVersion: version, workId: key, analysisRevision: version, orderedCommands: z.array(mutationCommandSchema).max(100), before: z.array(factSchema).max(500), after: z.array(factSchema).max(500), sourceRefs: internalSources, reviewIds: z.array(key).max(100), pendingFields: z.array(safeField).max(100).optional(), reviewReasons: z.array(key).max(100).optional(), state: z.enum(['ready', 'review', 'noop']) }).superRefine((plan, ctx) => {
  const previous = new Map<string, z.infer<typeof mutationCommandSchema>>();
  plan.orderedCommands.forEach((command, i) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', path: ['orderedCommands', i], message });
    if (previous.has(command.commandKey)) fail('Duplicate command key.');
    if (command.dependencies.some(k => !previous.has(k))) fail('Dependency must precede command in this plan.');
    if ('target' in command && command.target !== undefined && 'commandKey' in command.target) {
      const target = command.target;
      const parent = previous.get(target.commandKey);
      if (!parent || parent.kind !== `create_${target.kind}` || !command.dependencies.includes(target.commandKey)) fail('Invalid creation reference.');
    }
    previous.set(command.commandKey, command);
  });
  if (plan.state === 'noop' && plan.orderedCommands.length > 0) ctx.addIssue({ code: 'custom', message: 'Noop contains commands.' });
});
export const actorSchema = z.strictObject({ userId: key, clientId: key, scopes: z.array(z.string().min(1).max(100)).max(100), expiresAt: z.number().finite().positive().optional() });
export const authorizedPlanSchema = z.strictObject({ plan: syncPlanSchema, actor: actorSchema, commandCapabilities: z.array(z.strictObject({ commandKey: key, capabilities: z.array(capabilitySchema).min(1) })).max(100), validUntil: date });
export const operationReceiptSchema = z.strictObject({ operationId: key, commandKey: key, state: z.enum(['reserved', 'running', 'confirmed', 'rejected', 'uncertain', 'review']), crmRef: z.union([crmRefSchema, z.strictObject({ kind: z.literal('task'), id: crmIdSchema })]).optional(), updatedFields: z.array(safeField).max(100), checkedAt: date.optional() });
export const operationStatusSchema = z.strictObject({ operationId: key, state: z.enum(['queued', 'running', 'applied', 'review', 'uncertain', 'authorization_expired']), receipts: z.array(operationReceiptSchema).max(100), pendingReasons: z.array(key).max(100) });
export const workLeaseSchema = z.strictObject({ workId: key, leaseToken: key, owner: actorSchema.pick({ userId: true, clientId: true }), fence: version, expiresAt: date, mode: z.enum(['preview', 'apply']), target: workTargetSchema });
export const coverageSchema: z.ZodType<Coverage> = z.strictObject({ complete: z.boolean(), missingReasons: z.array(z.string().min(1).max(300)).max(100), pagesRead: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });
// Read DTO ownership stays with the Chat and CRM adapters. These are internal,
// server-produced snapshots, not accepted as part of submit_analysis.
const conversationSnapshotSchema: z.ZodType<ConversationSnapshot> = z.strictObject({
  conversationId: positiveId, revision: key,
  contact: z.strictObject({ id: positiveId, name: z.string().optional(), email: z.string().optional(), phoneNumber: z.string().optional(), crmPersonId: positiveId.optional() }).nullable(),
  messages: z.array(z.strictObject({ id: positiveId, conversationId: positiveId.optional(), content: z.string().optional(), createdAt: z.number().finite().optional(), updatedAt: z.number().finite().optional(), private: z.boolean().optional(), senderType: z.string().optional(), senderName: z.string().optional(), senderId: positiveId.optional(), messageType: z.union([z.string(), z.number()]).optional(), direction: z.enum(['incoming', 'outgoing', 'activity', 'unknown']).optional() })).max(10000),
  attachments: z.array(z.strictObject({ id: positiveId, fileType: z.string().optional(), mimeType: z.string().optional(), byteSize: z.number().int().min(0).optional(), messageId: positiveId.optional() })).max(10000),
  coverage: coverageSchema, continuation: z.strictObject({ conversationId: positiveId, after: positiveId }).optional(),
});
const catalogSnapshotSchema = z.custom<CatalogSnapshot>(v => !!v && typeof v === 'object' && typeof (v as CatalogSnapshot).version === 'string' && Array.isArray((v as CatalogSnapshot).customFields));
export const customerCandidateSchema = z.strictObject({ ref: entityRefSchema, name: z.string().min(1).max(255), document: z.string().max(30).optional(), email: z.email().optional(), phone: z.string().max(80).optional(), organizationIds: z.array(crmIdSchema).max(100), sourceRefs: internalSources });
// Internal read metadata. This is never part of agentAnalysisSchema.
export const customerCandidatesSchema = z.strictObject({ candidates: z.array(customerCandidateSchema).max(1000), coverage: coverageSchema, identifierCoverage: z.array(z.strictObject({ entity: z.literal('organization'), field: z.literal('cnpj'), value: key, coverage: coverageSchema })).max(100).optional(), customerId: key.optional(), verifiedLinks: z.array(z.strictObject({ ref: entityRefSchema, sourceRefs: internalSources.min(1) })).max(100).optional() });
const recordSnapshotSchema = z.strictObject({ ref: taskParentSchema, fields: z.array(factSchema).max(500), lastWritten: z.array(factSchema).max(500).optional(), lockedFields: z.array(safeField).max(100).optional() });
export const dealSnapshotSchema = z.strictObject({ ref: existingDeal, demandId: key.optional(), revision: key, status: z.enum(['open', 'won', 'lost']), funnelId: crmIdSchema, stageId: crmIdSchema, stage: stageKeySchema, fields: z.array(factSchema).max(500), lastWritten: z.array(factSchema).max(500).optional(), lockedFields: z.array(safeField).max(100).optional() });
export const workflowSnapshotSchema = z.strictObject({ conversations: z.array(conversationSnapshotSchema).max(100), candidates: customerCandidatesSchema, catalog: catalogSnapshotSchema, sourceRefs: internalSources.optional(), records: z.array(recordSnapshotSchema).max(1000).optional(), deals: z.array(dealSnapshotSchema).max(1000).optional() });
export const preparedWorkSchema = z.strictObject({ workId: key, leaseToken: key, expiresAt: date, snapshotVersion: version, contextVersion: z.number().int().min(0), customerId: key, markdown: z.string().max(32768), snapshot: workflowSnapshotSchema, catalogVersion: key, coverage: coverageSchema, reviewDecision: z.strictObject({ reviewId: key, version, decision: reviewDecisionSchema }).optional() });
export const snapshotManifestSchema = z.strictObject({ workId: key, snapshotVersion: version, contextVersion: z.number().int().min(0), catalogVersion: key, readAt: date, sources: internalSources, messages: z.array(z.strictObject({ conversationId: positiveId, id: positiveId, revision: key, hash: key, direction: z.enum(['incoming', 'outgoing', 'activity', 'unknown']), senderType: z.string().max(80).optional(), senderId: positiveId.optional() })).max(10000), records: z.array(z.strictObject({ ref: taskParentSchema, revision: key, hash: key })).max(1000), coverage: coverageSchema });
export const prepareResultSchema = z.discriminatedUnion('state', [z.strictObject({ state: z.literal('ready'), work: preparedWorkSchema }), z.strictObject({ state: z.literal('continue'), workId: key, continuation: key, leaseToken: key.optional(), manifest: snapshotManifestSchema, coverage: coverageSchema }), z.strictObject({ state: z.literal('deferred'), workId: key, retryAt: date, leaseToken: key.optional(), continuation: key.optional() }), z.strictObject({ state: z.literal('empty') }), z.strictObject({ state: z.literal('review'), workId: key, reviewIds: z.array(key).min(1) })]);
export const customerContextSchema = z.strictObject({ customerId: key, version, verifiedAt: date, markdown: z.string().refine(v => new TextEncoder().encode(v).length <= 32768, 'Context exceeds 32 KiB.'), evidenceRefs: internalSources });
export const demandRecordSchema = z.strictObject({ demandId: key, customerId: key, clientKey: key, dealRef: existingDeal.optional(), references: z.array(demandReferenceSchema).max(100).optional(), service: z.string().min(1).max(300), scope: z.string().min(1).max(2000), state: z.enum(['open', 'won', 'lost']), sourceRefs: internalSources });
const reasons = z.array(key).max(100);
export const customerResolutionSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('resolved'), customerId: key, ref: entityRefSchema, sourceRefs: internalSources, reviewReasons: reasons }), z.strictObject({ kind: z.literal('create'), customerId: key, proposal: selectionSchema, sourceRefs: internalSources, reviewReasons: reasons }).refine(v => v.proposal.kind === 'new'), z.strictObject({ kind: z.literal('review'), sourceRefs: internalSources, reviewReasons: reasons.min(1) })]);
export const demandResolutionSchema = z.strictObject({ demands: z.array(z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('resolved'), clientKey: key, demandId: key, sourceRefs: internalSources, reviewReasons: reasons }), z.strictObject({ kind: z.literal('create'), clientKey: key, demandId: key, sourceRefs: internalSources, reviewReasons: reasons }), z.strictObject({ kind: z.literal('review'), clientKey: key, sourceRefs: internalSources, reviewReasons: reasons.min(1) })])).max(100), reviewReasons: reasons });
export const resolutionBundleSchema = z.strictObject({ customer: customerResolutionSchema, demands: demandResolutionSchema });
export const plannerDecisionSchema = z.strictObject({ canCreateDeal: z.boolean(), pendingFields: z.array(safeField).max(100), commands: z.array(mutationCommandSchema).max(100), reviewReasons: reasons });
export const stageEvidenceSchemaForDecision = z.strictObject({ demandId: key, requested: stageKeySchema, sourceRefs: internalSources.min(1), approach: z.enum(['client', 'elotenant', 'unknown']), explicitRequest: z.boolean(), funnelMapping: automationPolicySchema.shape.funnelMapping.optional(), mapping: automationPolicySchema.shape.stageMapping.optional(), catalog: catalogSnapshotSchema.optional(), observations: z.array(z.strictObject({ demandId: key, event: stageEvent, actor: stageActor, direction: z.enum(['incoming', 'outgoing', 'activity', 'unknown']), sources: internalSources.min(1) })).max(100).optional() });
export const stageDecisionSchema = z.strictObject({ ref: existingDeal, patch: changeStageSchema.optional(), reviewReasons: reasons, sourceRefs: internalSources });
export const fieldPatchInputSchema = z.strictObject({ ref: entityRefSchema.or(existingDeal), facts: z.array(factSchema).max(500), current: z.array(factSchema).max(500), catalog: catalogSnapshotSchema, policy: automationPolicySchema.optional(), lastWritten: z.array(factSchema).max(500).optional(), lockedFields: z.array(safeField).max(100).optional() });
export const fieldPatchDecisionSchema = z.strictObject({ ref: taskParentSchema, patch: z.union([enrichOrganizationSchema, enrichPersonSchema, enrichDealSchema]).optional(), reviewReasons: reasons, sourceRefs: internalSources });
export const contextProjectionSchema = z.strictObject({ customerId: key, version, verifiedAt: date, primaryRef: entityRefSchema.optional(), facts: z.array(factSchema).max(500), contacts: z.array(customerCandidateSchema).max(100), demands: z.array(demandRecordSchema).max(100), receipts: z.array(operationReceiptSchema).max(100), pendingReasons: reasons, pendingPlanIds: z.array(key).max(100).optional(), corrections: z.array(z.strictObject({ previous: factSchema, replacement: factSchema }).refine(v => v.previous.entity === v.replacement.entity && v.previous.field === v.replacement.field && v.replacement.certainty === 'confirmed', 'Correction must replace the same confirmed field.')).max(100).optional() });
export const reserveWorkInputSchema = z.strictObject({ requestId: key, target: workTargetSchema, mode: z.enum(['preview', 'apply']), actor: actorSchema, payloadDigest: key });
export const budgetTicketSchema = z.discriminatedUnion('allowed', [z.strictObject({ allowed: z.literal(true), reservationId: key }), z.strictObject({ allowed: z.literal(false), retryAt: z.number().finite().min(0) })]);
export const snapshotVersionSchema = z.strictObject({ snapshotVersion: version, contextVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), catalogVersion: key });
export const planBasisSchema = snapshotVersionSchema.extend({ lease: workLeaseSchema, customerId: key });
export const commandReservationSchema = planBasisSchema.extend({ operationId: key, command: mutationCommandSchema, authorization: authorizedPlanSchema, expectedVersion: version, payloadDigest: key });
export const reservationResultSchema = z.discriminatedUnion('state', [z.strictObject({ state: z.literal('reserved'), version, fence: version }), z.strictObject({ state: z.literal('busy'), version }), z.strictObject({ state: z.literal('already_confirmed'), version, receipt: operationReceiptSchema }), z.strictObject({ state: z.literal('uncertain'), version, receipt: operationReceiptSchema }), z.strictObject({ state: z.literal('review'), version, reviewReasons: reasons })]);
export const commandCompletionSchema = z.strictObject({ operationId: key, commandKey: key, fence: version, expectedVersion: version, receipt: operationReceiptSchema });
export const reconciliationResultSchema = z.discriminatedUnion('state', [z.strictObject({ state: z.literal('confirmed'), receipt: operationReceiptSchema }), z.strictObject({ state: z.literal('uncertain'), reviewReasons: reasons }), z.strictObject({ state: z.literal('review'), reviewReasons: reasons })]);
export const applyInputSchema = z.strictObject({ planId: key, planVersion: version, requestId: key });
export const customerContextInputSchema = z.strictObject({ customerId: key, demandId: key.optional() });
export const listReviewsInputSchema = z.strictObject({ customerId: key.optional(), cursor: key.optional(), hintCursor: key.optional(), limit: z.number().int().min(1).max(100).default(20) });
export const reviewResolutionInputSchema = z.strictObject({ reviewId: key, expectedVersion: version, decision: reviewDecisionSchema });
export const auditInputSchema = z.strictObject({ cursor: key.optional(), limit: z.number().int().min(1).max(100).default(20) });
export const reprocessInputSchema = z.strictObject({ requestId: key, target: workTargetSchema, mode: z.enum(['preview', 'apply']).default('preview'), from: date, to: date }).refine(v => Date.parse(v.from) <= Date.parse(v.to), 'Invalid time range.').refine(v => v.target.kind !== 'pending', 'Reprocessing requires a bounded conversation/customer target.');
export const automationStatusSchema = z.strictObject({ mode: automationPolicySchema.shape.mode, policyVersion: version, pendingReviews: z.number().int().min(0), pendingOperations: z.number().int().min(0), state: z.enum(['ready', 'degraded', 'paused']).optional(), awaitingAgent: z.number().int().min(0).optional(), incompleteCoverage: z.number().int().min(0).optional(), pendingHints: z.number().int().min(0).optional() });
