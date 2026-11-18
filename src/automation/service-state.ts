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
import type { z } from 'zod';
import type { listReviewsInputSchema, reviewResolutionInputSchema, preflightInputSchema } from './schemas';

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
  pendingReview?: {
    reviewId: string;
    version: number;
    sourceSnapshotVersion: number;
    sourceRefs: SourceRef[];
    analysis: AgentAnalysis;
    policyVersion: number;
    decision: NonNullable<WorkflowReview['decision']>;
    clientKey?: string;
  };
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
