import { z } from 'zod';
import type { CatalogSnapshot } from '../../shared/contracts/crm';
import {
  createOrganizationSchema,
  createPersonSchema,
  createTaskRecordSchema,
  crmIdSchema,
  customFieldMatchesCatalog,
  entityRefSchema,
} from '../../shared/contracts/crm-mutations';
import { automationPolicySchema, stageKeySchema } from '../policy-types';
import {
  internalSources,
  key,
  date,
  sourceRefSchema,
  sources,
  submittedFactSchema,
  submittedSourceRefSchema,
  version,
} from './common';

export const reviewDecisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('selectCustomer'), ref: entityRefSchema }),
  z.strictObject({ kind: z.literal('selectDemand'), demandId: key }),
  z.strictObject({ kind: z.literal('correctFacts'), facts: z.array(submittedFactSchema).min(1).max(500) }),
  z.strictObject({ kind: z.literal('approvePlan'), planId: key, planVersion: version }),
  z.strictObject({ kind: z.literal('reject'), reason: z.string().min(1).max(2000) }),
]);
export const selectionSchema = z.union([
  entityRefSchema,
  z.strictObject({ kind: z.literal('new'), entity: z.literal('organization'), record: createOrganizationSchema }),
  z.strictObject({ kind: z.literal('new'), entity: z.literal('person'), record: createPersonSchema }),
]);
const approachSchema = z.strictObject({ value: z.enum(['client', 'elotenant', 'unknown']), sources });
export const stageEvent = z.enum([
  'request',
  'preparation',
  'internal_approval_pending',
  'internal_approval_completed',
  'proposal_sent',
  'future_send',
  'client_approval',
  'proposal_received',
]);
export const stageActor = z.enum(['elotenant', 'client', 'third_party', 'unknown']);
const stageObservation = z.strictObject({ demandKey: key, event: stageEvent, actor: stageActor, sources });
const stageEvidenceSchema = z.strictObject({
  value: stageKeySchema,
  sources,
  observations: z.array(stageObservation).max(100).optional(),
});
const itemSchema = z.strictObject({
  productId: crmIdSchema,
  quantity: z.number().finite().positive(),
  unitValue: z.number().finite().min(0).max(1_000_000_000_000).optional(),
  unit: z.string().min(1).max(80).optional(),
  discount: z.number().finite().min(0).max(100).optional(),
  sources,
});
const commitmentSchema = z
  .strictObject({
    text: z.string().min(1).max(2000),
    dueAt: date.optional(),
    relativeDue: z
      .strictObject({ days: z.number().int().min(0).max(366), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) })
      .optional(),
    type: createTaskRecordSchema.shape.type.optional(),
    assignedUserId: crmIdSchema.optional(),
    sources,
  })
  .refine(
    (v) => (v.dueAt !== undefined) !== (v.relativeDue !== undefined),
    'Provide one explicit due date or relative date.',
  );
export const demandReferenceSchema = z.strictObject({
  kind: z.enum(['order', 'proposal', 'project']),
  value: key,
  sources,
});
export const demandAnalysisSchema = z.strictObject({
  clientKey: key,
  existingDemandId: key.optional(),
  references: z.array(demandReferenceSchema).max(100).optional(),
  service: z.string().min(1).max(300),
  scope: z.string().min(1).max(2000),
  explicitRequest: z.strictObject({ value: z.boolean(), sources }),
  approach: approachSchema,
  stage: stageEvidenceSchema,
  items: z.array(itemSchema).max(100),
  commitments: z.array(commitmentSchema).max(100),
});
export const ambiguitySchema = z.strictObject({
  code: key,
  description: z.string().min(1).max(2000),
  sources,
  clientKey: key.optional(),
});
export const agentAnalysisSchema = z
  .strictObject({
    customerSelection: selectionSchema,
    facts: z.array(submittedFactSchema).max(500),
    demands: z.array(demandAnalysisSchema).max(100),
    ambiguities: z.array(ambiguitySchema).max(100),
  })
  .refine((v) => new Set(v.demands.map((d) => d.clientKey)).size === v.demands.length, 'Duplicate demand clientKey.');
export const analysisInputSchema = z.strictObject({
  workId: key,
  leaseToken: key,
  expectedSnapshotVersion: version,
  expectedContextVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  analysis: agentAnalysisSchema,
});
export type AnalysisValidationContext = {
  sourceRefs: z.infer<typeof submittedSourceRefSchema>[];
  candidates: z.infer<typeof entityRefSchema>[];
  existingDemandIds: string[];
  catalog: CatalogSnapshot;
  policy?: z.infer<typeof automationPolicySchema>;
};
/** Bind this to the persisted work, never to a manifest supplied by the agent. */
export function createAnalysisInputSchema(context: AnalysisValidationContext) {
  return analysisInputSchema.superRefine((input, ctx) => {
    const reject = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    const knownEntity = (kind: string, id: number) => context.candidates.some((c) => c.kind === kind && c.id === id);
    const selection = input.analysis.customerSelection;
    if (selection.kind !== 'new' && !knownEntity(selection.kind, selection.id))
      reject(['analysis', 'customerSelection'], 'Selection absent from snapshot.');
    if (
      selection.kind === 'new' &&
      selection.entity === 'person' &&
      selection.record.organization !== undefined &&
      !knownEntity('organization', selection.record.organization)
    )
      reject(['analysis', 'customerSelection'], 'Organization absent from snapshot.');
    // Traverse only schema-parsed structures; user objects cannot contribute extra keys.
    const checkSources = (value: unknown, path: (string | number)[]) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach((v, i) => checkSources(v, [...path, i]));
        return;
      }
      for (const [field, child] of Object.entries(value)) {
        if (field === 'sources' && Array.isArray(child))
          child.forEach((ref: z.infer<typeof submittedSourceRefSchema>, i) => {
            if (
              !context.sourceRefs.some(
                (s) => s.kind === ref.kind && s.id === ref.id && s.revision === ref.revision && s.field === ref.field,
              )
            )
              reject([...path, field, i], 'Source absent or stale in snapshot.');
          });
        else checkSources(child, [...path, field]);
      }
    };
    checkSources(input.analysis, ['analysis']);
    input.analysis.facts.forEach((fact, i) => {
      if (
        fact.clientKey !== undefined &&
        (fact.entity !== 'demand' || !input.analysis.demands.some((d) => d.clientKey === fact.clientKey))
      )
        reject(['analysis', 'facts', i], 'Fact demand absent from analysis.');
      if (
        fact.entity === 'person' &&
        fact.field === 'organization' &&
        (!crmIdSchema.safeParse(fact.value).success || !knownEntity('organization', fact.value as number))
      )
        reject(['analysis', 'facts', i], 'Organization absent from snapshot.');
      if (fact.field === 'ownerUser' && !context.catalog.users.some((u) => u.id === fact.value))
        reject(['analysis', 'facts', i], 'User absent from catalog.');
      if (fact.field.startsWith('customFields.')) {
        const entity = { organization: 'organizations', person: 'people', demand: 'deals' } as const;
        const logical = fact.field.slice(13);
        const mappings =
          context.policy?.customFieldMapping.filter((m) => m.entity === entity[fact.entity] && m.field === logical) ??
          [];
        const id = mappings.length === 1 ? mappings[0]!.catalogFieldId : logical;
        if (
          mappings.length > 1 ||
          !customFieldMatchesCatalog({ id, value: fact.value }, entity[fact.entity], context.catalog)
        )
          reject(['analysis', 'facts', i], 'Invalid catalog field.');
      }
    });
    if (selection.kind === 'new')
      for (const f of selection.record.customFields ?? [])
        if (!customFieldMatchesCatalog(f, selection.entity === 'person' ? 'people' : 'organizations', context.catalog))
          reject(['analysis', 'customerSelection'], 'Invalid catalog field.');
    input.analysis.demands.forEach((d, i) => {
      d.stage.observations?.forEach((observation, j) => {
        if (observation.demandKey !== d.clientKey)
          reject(['analysis', 'demands', i, 'stage', 'observations', j], 'Stage evidence belongs to another demand.');
      });
      if (d.existingDemandId && !context.existingDemandIds.includes(d.existingDemandId))
        reject(['analysis', 'demands', i, 'existingDemandId'], 'Demand absent from work.');
      d.items.forEach((item, j) => {
        if (!context.catalog.products.some((p) => p.id === item.productId))
          reject(['analysis', 'demands', i, 'items', j], 'Product absent from catalog.');
      });
      d.commitments.forEach((c, j) => {
        if (c.assignedUserId !== undefined && !context.catalog.users.some((u) => u.id === c.assignedUserId))
          reject(['analysis', 'demands', i, 'commitments', j], 'User absent from catalog.');
      });
    });
  });
}

export const pendingReviewSchema = z.strictObject({
  reviewId: z.string(),
  version: z.number().int().positive(),
  sourceSnapshotVersion: z.number().int().positive(),
  sourceRefs: internalSources,
  analysis: agentAnalysisSchema,
  policyVersion: z.number().int().positive(),
  decision: reviewDecisionSchema,
  clientKey: z.string().optional(),
});
export type PendingReview = {
  reviewId: string;
  version: number;
  sourceSnapshotVersion: number;
  sourceRefs: z.infer<typeof sourceRefSchema>[];
  analysis: z.infer<typeof agentAnalysisSchema>;
  policyVersion: number;
  decision: z.infer<typeof reviewDecisionSchema>;
  clientKey?: string;
};
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;
export type AgentAnalysis = z.infer<typeof agentAnalysisSchema>;
export type AnalysisInput = z.infer<typeof analysisInputSchema>;
