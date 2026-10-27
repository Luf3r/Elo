import type { CatalogPage, CatalogSnapshot, CustomerCandidates, PreparedWork, WorkLease, PlanBasis, AgentAnalysis, MutationCommand } from './types';
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
  direct?: { digest: string; capability: 'crm:create' | 'crm:enrich' | 'crm:write'; command: MutationCommand };
}
export interface WorkflowReview {
  reviewId: string;
  workId: string;
  customerId: string;
  version: number;
  owner: WorkLease['owner'];
  state: 'open' | 'resolved';
  reasons: string[];
  decision?: z.infer<typeof reviewResolutionInputSchema>['decision'];
}
export type ListReviewsInput = z.infer<typeof listReviewsInputSchema>;
