import type { CatalogPage, CatalogSnapshot, CustomerCandidates, PreparedWork, WorkLease, PlanBasis, AgentAnalysis, MutationCommand, SourceRef } from './types';
import type { ConversationSnapshot } from '../agendor/chat/types';
import type { z } from 'zod';
import type { listReviewsInputSchema, reviewResolutionInputSchema } from './schemas';

/** Server-owned state; neither this envelope nor an upstream route is an MCP input. */
export interface WorkflowState {
  revision: number;
  chatAccountId?: string;
  range?: { from: string; to: string };
  lease: WorkLease;
  customerId: string;
  continuation: string;
  step: number;
  conversationIds: number[];
  conversations: ConversationSnapshot[];
  pages: CatalogPage[];
  candidates: CustomerCandidates;
  catalog?: CatalogSnapshot;
  work?: PreparedWork;
  basis?: PlanBasis;
  analysis?: AgentAnalysis;
  snapshotVersion?: number;
  pendingReview?: { reviewId: string; version: number; sourceSnapshotVersion: number; sourceRefs: SourceRef[]; analysis: AgentAnalysis; policyVersion: number; decision: NonNullable<WorkflowReview['decision']>; clientKey?: string };
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
