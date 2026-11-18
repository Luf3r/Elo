import { z } from 'zod';
import type {
  CatalogPage,
  CatalogSnapshot,
  CustomerCandidates,
  PreparedWork,
  WorkLease,
  PlanBasis,
  AgentAnalysis,
  MutationCommand,
  SourceRef,
} from './types';
import type { ConversationSnapshot } from '../agendor/chat/types';
import {
  actorSchema,
  agentAnalysisSchema,
  catalogPageSchema,
  catalogSnapshotSchema,
  conversationSnapshotSchema,
  customerCandidatesSchema,
  dealSnapshotSchema,
  listReviewsInputSchema,
  mutationCommandSchema,
  planBasisSchema,
  preflightInputSchema,
  preparedWorkSchema,
  recordSnapshotSchema,
  reviewDecisionSchema,
  reviewResolutionInputSchema,
  sourceRefSchema,
  syncPlanSchema,
  workLeaseSchema,
} from './schemas';
import { pendingReviewSchema, type PendingReview } from '../domain/schemas/analysis';

/** Server-owned state; neither this envelope nor an upstream route is an MCP input. */
export interface WorkflowState {
  revision: number;
  chatAccountId?: string;
  discoveryId?: string;
  discoveryPlanId?: string;
  preparationDeferral?: { checkpoint: string; attempts: number; reason: string; blocked: boolean; nextRetryAt: string };
  scope?: Pick<z.infer<typeof preflightInputSchema>, 'inboxIds' | 'limits'>;
  range?: { from: string; to: string };
  lease: WorkLease;
  customerId: string;
  continuation: string;
  step: number;
  conversationIds: number[];
  conversations: ConversationSnapshot[];
  pages: CatalogPage[];
  candidates: CustomerCandidates;
  candidateReadCache?: Record<string, string>;
  verificationReads?: Record<string, ConversationSnapshot>;
  verificationPass?: { key: string; inboxes: number[] };
  catalog?: CatalogSnapshot;
  work?: PreparedWork;
  basis?: PlanBasis;
  analysis?: AgentAnalysis;
  snapshotVersion?: number;
  pendingReview?: PendingReview;
  hydration?: {
    offset: number;
    records: NonNullable<PreparedWork['snapshot']['records']>;
    deals: NonNullable<PreparedWork['snapshot']['deals']>;
    sources: SourceRef[];
    missingReasons: string[];
  };
  direct?: { digest: string; capability: 'crm:create' | 'crm:enrich' | 'crm:write'; command: MutationCommand };
}
export interface WorkflowReview {
  reviewId: string;
  workId: string;
  customerId: string;
  version: number;
  snapshotVersion?: number;
  owner: WorkLease['owner'];
  state: 'open' | 'resolved';
  reasons: string[];
  decision?: z.infer<typeof reviewResolutionInputSchema>['decision'];
  consumedBy?: { planId: string; planVersion: number; snapshotVersion: number };
}
export type ListReviewsInput = z.infer<typeof listReviewsInputSchema>;

export const workflowReviewSchema: z.ZodType<WorkflowReview> = z.strictObject({
  reviewId: z.string().min(1).max(300),
  workId: z.string().min(1).max(200),
  customerId: z.string().min(1).max(300),
  version: z.number().int().positive(),
  snapshotVersion: z.number().int().positive().optional(),
  owner: actorSchema.pick({ userId: true, clientId: true }),
  state: z.enum(['open', 'resolved']),
  reasons: z.array(z.string()),
  decision: reviewDecisionSchema.optional(),
  consumedBy: z
    .strictObject({
      planId: z.string().min(1).max(200),
      planVersion: z.number().int().positive(),
      snapshotVersion: z.number().int().positive(),
    })
    .optional(),
});

export const workflowStateSchema: z.ZodType<WorkflowState> = z.strictObject({
  revision: z.number().int().nonnegative(),
  chatAccountId: z.string().optional(),
  discoveryId: z.string().optional(),
  discoveryPlanId: z.string().optional(),
  preparationDeferral: z
    .strictObject({
      checkpoint: z.string(),
      attempts: z.number().int().nonnegative(),
      reason: z.string(),
      blocked: z.boolean(),
      nextRetryAt: z.string(),
    })
    .optional(),
  scope: preflightInputSchema.pick({ inboxIds: true, limits: true }).optional(),
  range: z.strictObject({ from: z.string(), to: z.string() }).optional(),
  lease: workLeaseSchema,
  customerId: z.string().min(1),
  continuation: z.string().min(1),
  step: z.number().int().nonnegative(),
  conversationIds: z.array(z.number().int().positive()),
  conversations: z.array(conversationSnapshotSchema),
  pages: z.array(catalogPageSchema),
  candidates: customerCandidatesSchema,
  candidateReadCache: z.record(z.string(), z.string()).optional(),
  verificationReads: z.record(z.string(), conversationSnapshotSchema).optional(),
  verificationPass: z.strictObject({ key: z.string(), inboxes: z.array(z.number().int()) }).optional(),
  catalog: catalogSnapshotSchema.optional(),
  work: preparedWorkSchema.optional(),
  basis: planBasisSchema.optional(),
  analysis: agentAnalysisSchema.optional(),
  snapshotVersion: z.number().int().nonnegative().optional(),
  pendingReview: pendingReviewSchema.optional(),
  hydration: z
    .strictObject({
      offset: z.number().int().nonnegative(),
      records: z.array(recordSnapshotSchema),
      deals: z.array(dealSnapshotSchema),
      sources: z.array(sourceRefSchema),
      missingReasons: z.array(z.string()),
    })
    .optional(),
  direct: z
    .strictObject({
      digest: z.string(),
      capability: z.enum(['crm:create', 'crm:enrich', 'crm:write']),
      command: mutationCommandSchema,
    })
    .optional(),
});

export const servicePlanEnvelopeSchema = z.strictObject({
  plan: syncPlanSchema,
  workflow: workflowStateSchema,
});
