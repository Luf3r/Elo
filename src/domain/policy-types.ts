import { z } from 'zod';
import { crmIdSchema } from '../shared/contracts/crm-mutations';
export const capabilitySchema = z.enum([
  'crm:read',
  'chat:read',
  'crm:create',
  'crm:enrich',
  'crm:write',
  'automation:read',
  'automation:process',
  'automation:manage',
]);
export const stageKeySchema = z.enum(['new_request', 'preparing_proposal', 'internal_approval', 'proposal_sent']);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const automationPolicySchema = z.strictObject({
  version,
  mode: z.enum(['disabled', 'preview', 'apply']),
  allowedInboxIds: z.array(crmIdSchema).max(100),
  capabilities: z.array(capabilitySchema).max(8),
  funnelMapping: z.strictObject({ client: crmIdSchema.optional(), elotenant: crmIdSchema.optional() }),
  stageMapping: z
    .array(z.strictObject({ funnelId: crmIdSchema, stage: stageKeySchema, stageId: crmIdSchema }))
    .max(100),
  customFieldMapping: z
    .array(
      z.strictObject({
        entity: z.enum(['organizations', 'people', 'deals']),
        field: z
          .string()
          .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/)
          .refine((v) => !['constructor', 'prototype', '__proto__'].includes(v)),
        catalogFieldId: z.union([
          crmIdSchema,
          z
            .string()
            .regex(/^[a-zA-Z0-9_-]{1,100}$/)
            .refine((v) => !['constructor', 'prototype', '__proto__'].includes(v)),
        ]),
      }),
    )
    .max(100),
  nativeCreatorDisabled: z.boolean(),
  limits: z.strictObject({
    maxConversations: z.number().int().min(1).max(100),
    maxCommands: z.number().int().min(1).max(100),
    maxRequests: z.number().int().min(1).max(100),
  }),
});
export const policyPatchSchema = automationPolicySchema
  .omit({ version: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0);
export const updatePolicyInputSchema = z.strictObject({ expectedVersion: version, patch: policyPatchSchema });
export type AutomationPolicy = z.infer<typeof automationPolicySchema>;
export type PolicyPatch = z.infer<typeof policyPatchSchema>;
export type Capability = z.infer<typeof capabilitySchema>;
