import { z } from 'zod';
import { automationPolicySchema } from '../../domain/policy-types';
import { reviewDecisionSchema } from '../../domain/schemas/analysis';
import { date, key, version } from '../../domain/schemas/common';
import { workTargetSchema } from '../../domain/schemas/snapshot';

export const applyInputSchema = z.strictObject({ planId: key, planVersion: version, requestId: key });
export const customerContextInputSchema = z.strictObject({ customerId: key, demandId: key.optional() });
export const listReviewsInputSchema = z.strictObject({
  customerId: key.optional(),
  cursor: key.optional(),
  hintCursor: key.optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export const reviewResolutionInputSchema = z.strictObject({
  reviewId: key,
  expectedVersion: version,
  decision: reviewDecisionSchema,
});
export const auditInputSchema = z.strictObject({
  cursor: key.optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export const reprocessInputSchema = z
  .strictObject({
    requestId: key,
    target: workTargetSchema,
    mode: z.enum(['preview', 'apply']).default('preview'),
    from: date,
    to: date,
  })
  .refine((v) => Date.parse(v.from) <= Date.parse(v.to), 'Invalid time range.')
  .refine((v) => v.target.kind !== 'pending', 'Reprocessing requires a bounded conversation/customer target.');
export const automationStatusSchema = z.strictObject({
  mode: automationPolicySchema.shape.mode,
  policyVersion: version,
  pendingReviews: z.number().int().min(0),
  pendingOperations: z.number().int().min(0),
  state: z.enum(['ready', 'degraded', 'paused']).optional(),
  awaitingAgent: z.number().int().min(0).optional(),
  preparing: z.number().int().min(0).optional(),
  blockedWork: z.number().int().min(0).optional(),
  expiredWork: z.number().int().min(0).optional(),
  incompleteCoverage: z.number().int().min(0).optional(),
  pendingHints: z.number().int().min(0).optional(),
});

export type ApplyInput = z.infer<typeof applyInputSchema>;
export type ReviewResolution = z.infer<typeof reviewResolutionInputSchema>;
export type ReprocessInput = z.infer<typeof reprocessInputSchema>;
export type AutomationStatus = z.infer<typeof automationStatusSchema>;
