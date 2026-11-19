import { z } from 'zod';
import { TENANT_ACCOUNT_KEY } from '../../app/config/tenant';
import {
  changeStageSchema,
  createDealRecordSchema,
  createOrganizationSchema,
  createPersonSchema,
  createTaskRecordSchema,
  crmIdSchema,
  enrichDealSchema,
  enrichOrganizationSchema,
  enrichPersonSchema,
  updateTaskSchema,
} from '../../shared/contracts/crm-mutations';
import {
  updateDealInput,
  updateDealStageInput,
  updateOrganizationInput,
  updatePersonInput,
} from '../../shared/contracts/crm-updates';
import { automationPolicySchema, capabilitySchema } from '../policy-types';
import { demandReferenceSchema, selectionSchema, stageActor, stageEvent } from './analysis';
import {
  date,
  entityRefSchema,
  existingDeal,
  existingOrganization,
  existingPerson,
  factSchema,
  internalSources,
  key,
  reasons,
  safeField,
  stageKeySchema,
  taskParentSchema,
  version,
} from './common';
import { catalogSnapshotSchema, workTargetSchema } from './snapshot';

export const crmRefSchema = taskParentSchema;
export const commandTargetSchema = z.union([
  taskParentSchema,
  z.strictObject({ kind: z.enum(['organization', 'person', 'deal']), commandKey: key }),
]);
const commandMeta = {
  commandKey: key,
  dependencies: z.array(key).max(100),
  before: z.array(factSchema).max(500),
  sourceRefs: internalSources.min(1),
  requiredCapabilities: z.array(capabilitySchema).min(1).max(8),
};
export const mutationCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...commandMeta,
    kind: z.literal('legacy_update_organization'),
    target: existingOrganization,
    patch: updateOrganizationInput,
  }),
  z.strictObject({
    ...commandMeta,
    kind: z.literal('legacy_update_person'),
    target: existingPerson,
    patch: updatePersonInput,
  }),
  z.strictObject({
    ...commandMeta,
    kind: z.literal('legacy_update_deal'),
    target: existingDeal,
    patch: updateDealInput,
  }),
  z.strictObject({
    ...commandMeta,
    kind: z.literal('legacy_update_stage'),
    target: existingDeal,
    patch: updateDealStageInput,
  }),
  z.strictObject({ ...commandMeta, kind: z.literal('create_organization'), payload: createOrganizationSchema }),
  z
    .strictObject({
      ...commandMeta,
      kind: z.literal('create_person'),
      target: z
        .union([existingOrganization, z.strictObject({ kind: z.literal('organization'), commandKey: key })])
        .optional(),
      payload: createPersonSchema,
    })
    .refine((v) => !v.target || v.payload.organization === undefined, 'Use one explicit organization link.'),
  z
    .strictObject({
      ...commandMeta,
      kind: z.literal('create_deal'),
      target: commandTargetSchema,
      payload: createDealRecordSchema,
    })
    .refine((v) => v.target.kind !== 'deal', 'Deal requires one company/person parent.'),
  z.strictObject({
    ...commandMeta,
    kind: z.literal('create_task'),
    target: commandTargetSchema,
    payload: createTaskRecordSchema,
  }),
  z.strictObject({
    ...commandMeta,
    kind: z.literal('enrich_organization'),
    target: existingOrganization,
    patch: enrichOrganizationSchema,
  }),
  z.strictObject({
    ...commandMeta,
    kind: z.literal('enrich_person'),
    target: existingPerson,
    patch: enrichPersonSchema,
  }),
  z.strictObject({ ...commandMeta, kind: z.literal('enrich_deal'), target: existingDeal, patch: enrichDealSchema }),
  z.strictObject({
    ...commandMeta,
    kind: z.literal('update_task'),
    target: z.strictObject({ kind: z.literal('task'), id: crmIdSchema }),
    patch: updateTaskSchema,
  }),
  z.strictObject({
    ...commandMeta,
    kind: z.literal('change_stage'),
    target: z.union([existingDeal, z.strictObject({ kind: z.literal('deal'), commandKey: key })]),
    patch: changeStageSchema,
  }),
]);
export const syncPlanSchema = z
  .strictObject({
    planId: key,
    version,
    policyVersion: version,
    workId: key,
    analysisRevision: version,
    orderedCommands: z.array(mutationCommandSchema).max(100),
    before: z.array(factSchema).max(500),
    after: z.array(factSchema).max(500),
    sourceRefs: internalSources,
    reviewIds: z.array(key).max(100),
    pendingFields: z.array(safeField).max(100).optional(),
    reviewReasons: z.array(key).max(100).optional(),
    state: z.enum(['ready', 'review', 'noop']),
  })
  .superRefine((plan, ctx) => {
    const previous = new Map<string, z.infer<typeof mutationCommandSchema>>();
    plan.orderedCommands.forEach((command, i) => {
      const fail = (message: string) => ctx.addIssue({ code: 'custom', path: ['orderedCommands', i], message });
      if (previous.has(command.commandKey)) fail('Duplicate command key.');
      if (command.dependencies.some((k) => !previous.has(k))) fail('Dependency must precede command in this plan.');
      if ('target' in command && command.target !== undefined && 'commandKey' in command.target) {
        const target = command.target;
        const parent = previous.get(target.commandKey);
        if (!parent || parent.kind !== `create_${target.kind}` || !command.dependencies.includes(target.commandKey))
          fail('Invalid creation reference.');
      }
      previous.set(command.commandKey, command);
    });
    if (plan.state === 'noop' && plan.orderedCommands.length > 0)
      ctx.addIssue({ code: 'custom', message: 'Noop contains commands.' });
  });
export const actorSchema = z.strictObject({
  userId: key,
  clientId: key,
  scopes: z.array(z.string().min(1).max(100)).max(100),
  expiresAt: z.number().finite().positive().optional(),
});
export const authorizedPlanSchema = z.strictObject({
  plan: syncPlanSchema,
  actor: actorSchema,
  commandCapabilities: z
    .array(z.strictObject({ commandKey: key, capabilities: z.array(capabilitySchema).min(1) }))
    .max(100),
  validUntil: date,
});
export const workLeaseSchema = z.strictObject({
  workId: key,
  leaseToken: key,
  owner: actorSchema.pick({ userId: true, clientId: true }),
  fence: version,
  expiresAt: date,
  mode: z.enum(['preview', 'apply']),
  target: workTargetSchema,
});
export const demandRecordSchema = z.strictObject({
  demandId: key,
  customerId: key,
  clientKey: key,
  dealRef: existingDeal.optional(),
  references: z.array(demandReferenceSchema).max(100).optional(),
  service: z.string().min(1).max(300),
  scope: z.string().min(1).max(2000),
  state: z.enum(['open', 'won', 'lost']),
  sourceRefs: internalSources,
});
export const customerResolutionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('resolved'),
    customerId: key,
    ref: entityRefSchema,
    sourceRefs: internalSources,
    reviewReasons: reasons,
  }),
  z
    .strictObject({
      kind: z.literal('create'),
      customerId: key,
      proposal: selectionSchema,
      sourceRefs: internalSources,
      reviewReasons: reasons,
    })
    .refine((v) => v.proposal.kind === 'new'),
  z.strictObject({ kind: z.literal('review'), sourceRefs: internalSources, reviewReasons: reasons.min(1) }),
]);
export const demandResolutionSchema = z.strictObject({
  demands: z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({
          kind: z.literal('resolved'),
          clientKey: key,
          demandId: key,
          sourceRefs: internalSources,
          reviewReasons: reasons,
        }),
        z.strictObject({
          kind: z.literal('create'),
          clientKey: key,
          demandId: key,
          sourceRefs: internalSources,
          reviewReasons: reasons,
        }),
        z.strictObject({
          kind: z.literal('review'),
          clientKey: key,
          sourceRefs: internalSources,
          reviewReasons: reasons.min(1),
        }),
      ]),
    )
    .max(100),
  reviewReasons: reasons,
});
export const resolutionBundleSchema = z.strictObject({
  customer: customerResolutionSchema,
  demands: demandResolutionSchema,
});
export const plannerDecisionSchema = z.strictObject({
  canCreateDeal: z.boolean(),
  pendingFields: z.array(safeField).max(100),
  commands: z.array(mutationCommandSchema).max(100),
  reviewReasons: reasons,
});
export const stageEvidenceSchemaForDecision = z.strictObject({
  demandId: key,
  requested: stageKeySchema,
  sourceRefs: internalSources.min(1),
  approach: z.enum(['client', TENANT_ACCOUNT_KEY, 'unknown'] as const),
  explicitRequest: z.boolean(),
  funnelMapping: automationPolicySchema.shape.funnelMapping.optional(),
  mapping: automationPolicySchema.shape.stageMapping.optional(),
  catalog: catalogSnapshotSchema.optional(),
  observations: z
    .array(
      z.strictObject({
        demandId: key,
        event: stageEvent,
        actor: stageActor,
        direction: z.enum(['incoming', 'outgoing', 'activity', 'unknown']),
        sources: internalSources.min(1),
      }),
    )
    .max(100)
    .optional(),
});
export const stageDecisionSchema = z.strictObject({
  ref: existingDeal,
  patch: changeStageSchema.optional(),
  reviewReasons: reasons,
  sourceRefs: internalSources,
});
export const fieldPatchInputSchema = z.strictObject({
  ref: entityRefSchema.or(existingDeal),
  facts: z.array(factSchema).max(500),
  current: z.array(factSchema).max(500),
  catalog: catalogSnapshotSchema,
  policy: automationPolicySchema.optional(),
  lastWritten: z.array(factSchema).max(500).optional(),
  lockedFields: z.array(safeField).max(100).optional(),
});
export const fieldPatchDecisionSchema = z.strictObject({
  ref: taskParentSchema,
  patch: z.union([enrichOrganizationSchema, enrichPersonSchema, enrichDealSchema]).optional(),
  reviewReasons: reasons,
  sourceRefs: internalSources,
});

export type SyncPlan = z.infer<typeof syncPlanSchema>;
export type MutationCommand = z.infer<typeof mutationCommandSchema>;
export type Actor = z.infer<typeof actorSchema>;
export type WorkLease = z.infer<typeof workLeaseSchema>;
export type AuthorizedPlan = z.infer<typeof authorizedPlanSchema>;
export type DemandRecord = z.infer<typeof demandRecordSchema>;
export type CustomerResolution = z.infer<typeof customerResolutionSchema>;
export type DemandResolution = z.infer<typeof demandResolutionSchema>;
export type ResolutionBundle = z.infer<typeof resolutionBundleSchema>;
export type PlannerDecision = z.infer<typeof plannerDecisionSchema>;
export type StageEvidence = z.infer<typeof stageEvidenceSchemaForDecision>;
export type StageDecision = z.infer<typeof stageDecisionSchema>;
export type FieldPatchInput = z.infer<typeof fieldPatchInputSchema>;
export type FieldPatchDecision = z.infer<typeof fieldPatchDecisionSchema>;
