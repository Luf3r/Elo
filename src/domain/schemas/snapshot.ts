import { z } from 'zod';
import type { CatalogPage, CatalogSnapshot } from '../../shared/contracts/crm';
import type { ConversationSnapshot, Coverage } from '../../shared/contracts/chat';
import { crmIdSchema } from '../../shared/contracts/crm-mutations';
import { positiveId, recordSchema } from '../../shared/contracts/crm-updates';
import { reviewDecisionSchema } from './analysis';
import {
  date,
  entityRefSchema,
  existingDeal,
  factSchema,
  internalSources,
  key,
  safeField,
  stageKeySchema,
  taskParentSchema,
  version,
} from './common';

export const workTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('conversation'), conversationId: positiveId }),
  z.strictObject({ kind: z.literal('customer'), customerId: key }),
  z.strictObject({ kind: z.literal('pending') }),
]);
export const maxPreparationPages = 100;
export const preparationLimitsSchema = z.strictObject({
  maxMessagePages: z.number().int().min(1).max(maxPreparationPages).optional(),
  maxAttachmentPages: z.number().int().min(0).max(maxPreparationPages).optional(),
});
export const preflightInputSchema = z.strictObject({
  target: workTargetSchema,
  mode: z.enum(['preview', 'apply']),
  inboxIds: z.array(positiveId).min(1).max(100).optional(),
  limits: preparationLimitsSchema.optional(),
});
export const prepareInputSchema = z.union([
  preflightInputSchema.extend({ requestId: key }),
  z.strictObject({ requestId: key, workId: key, leaseToken: key, continuation: key }),
]);

export const coverageSchema: z.ZodType<Coverage> = z.strictObject({
  complete: z.boolean(),
  missingReasons: z.array(z.string().min(1).max(300)).max(100),
  pagesRead: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  history: z
    .strictObject({
      startReached: z.boolean(),
      endReached: z.boolean(),
      messagesRead: z.number().int().nonnegative(),
      pagesRead: z.number().int().nonnegative(),
      complete: z.boolean(),
    })
    .optional(),
  messagePagination: z.literal('verified').optional(),
  messageHistory: z.enum(['complete', 'partial']).optional(),
  conversationDiscovery: z.enum(['complete', 'partial']).optional(),
  attachmentListing: z.enum(['complete', 'partial']).optional(),
  editedMessageContent: z
    .strictObject({ status: z.literal('unavailable'), reason: z.literal('upstream_whatsapp_api_limitation') })
    .optional(),
  conversationsRead: z.number().int().nonnegative().optional(),
  attachmentCount: z.number().int().nonnegative().optional(),
});
// Read DTO ownership stays with the Chat and CRM adapters. These are internal,
// server-produced snapshots, not accepted as part of submit_analysis.
export const conversationSnapshotSchema: z.ZodType<ConversationSnapshot> = z.strictObject({
  conversationId: positiveId,
  inboxId: positiveId.optional(),
  revision: key,
  contact: z
    .strictObject({
      id: positiveId,
      name: z.string().optional(),
      email: z.string().optional(),
      phoneNumber: z.string().optional(),
      crmPersonId: positiveId.optional(),
    })
    .nullable(),
  messages: z
    .array(
      z.strictObject({
        id: positiveId,
        conversationId: positiveId.optional(),
        content: z.string().optional(),
        createdAt: z.number().finite().optional(),
        updatedAt: z.number().finite().optional(),
        private: z.boolean().optional(),
        senderType: z.string().optional(),
        senderName: z.string().optional(),
        senderId: positiveId.optional(),
        messageType: z.union([z.string(), z.number()]).optional(),
        attachments: z
          .array(
            z.strictObject({
              id: positiveId,
              fileType: z.string().optional(),
              mimeType: z.string().optional(),
              byteSize: z.number().int().nonnegative().optional(),
              messageId: positiveId.optional(),
            }),
          )
          .max(1000)
          .optional(),
        direction: z.enum(['incoming', 'outgoing', 'activity', 'unknown']).optional(),
      }),
    )
    .max(10000),
  attachments: z
    .array(
      z.strictObject({
        id: positiveId,
        fileType: z.string().optional(),
        mimeType: z.string().optional(),
        byteSize: z.number().int().min(0).optional(),
        messageId: positiveId.optional(),
      }),
    )
    .max(10000),
  attachmentListing: z
    .strictObject({
      complete: z.boolean(),
      pagesRead: z.number().int().nonnegative(),
      nextPage: positiveId.nullable(),
      endReached: z.boolean(),
      missingReasons: z.array(z.string()),
      source: z.enum(['attachment_endpoint', 'message_history', 'combined']).optional(),
      messagePagesRead: z.number().int().nonnegative().optional(),
    })
    .optional(),
  coverage: coverageSchema,
  continuation: z.strictObject({ conversationId: positiveId, after: positiveId }).optional(),
});
export const catalogSnapshotSchema = z.custom<CatalogSnapshot>(
  (v) =>
    !!v &&
    typeof v === 'object' &&
    typeof (v as CatalogSnapshot).version === 'string' &&
    Array.isArray((v as CatalogSnapshot).customFields),
);
export const catalogPageSchema: z.ZodType<CatalogPage> = z.strictObject({
  items: z.array(recordSchema),
  pageInfo: z.strictObject({
    page: z.number().int().nonnegative(),
    perPage: z.number().int().positive(),
    hasNext: z.boolean(),
    nextPage: z.number().int().positive().nullable(),
  }),
  section: z.enum([
    'funnels',
    'stages',
    'customFields',
    'users',
    'products',
    'origins',
    'categories',
    'sectors',
    'cities',
  ]),
  entityType: z.enum(['organizations', 'people', 'deals', 'products']).optional(),
  funnelId: positiveId.optional(),
  state: z.string().optional(),
  fetchedAt: z.string(),
  coverage: z.strictObject({
    status: z.enum(['partial', 'complete']),
    pages: z.array(z.number().int().nonnegative()),
  }),
});
export const customerCandidateSchema = z.strictObject({
  ref: entityRefSchema,
  name: z.string().min(1).max(255),
  document: z.string().max(30).optional(),
  email: z.email().optional(),
  phone: z.string().max(80).optional(),
  organizationIds: z.array(crmIdSchema).max(100),
  sourceRefs: internalSources,
});
// Internal read metadata. This is never part of agentAnalysisSchema.
export const customerCandidatesSchema = z.strictObject({
  candidates: z.array(customerCandidateSchema).max(1000),
  coverage: coverageSchema,
  identifierCoverage: z
    .array(
      z.strictObject({
        entity: z.literal('organization'),
        field: z.literal('cnpj'),
        value: key,
        coverage: coverageSchema,
      }),
    )
    .max(100)
    .optional(),
  customerId: key.optional(),
  crmContactLink: z
    .strictObject({
      status: z.enum(['verified', 'missing', 'stale', 'query_failed']),
      chatContactId: positiveId,
      crmPersonId: positiveId.optional(),
      method: z.literal('direct_agendor_link').optional(),
    })
    .optional(),
  candidateRead: z
    .strictObject({
      status: z.enum(['not_needed', 'verified', 'no_candidate', 'ambiguous', 'query_failed']),
      selectedPersonId: positiveId.optional(),
      matchedBy: z.array(z.string()).optional(),
    })
    .optional(),
  duplicateCheck: z
    .strictObject({
      status: z.enum(['not_checked', 'none', 'possible_duplicate', 'high_confidence_duplicate', 'query_failed']),
      currentPersonId: positiveId.optional(),
      candidatePersonIds: z.array(positiveId).optional(),
      reasons: z.array(z.string()).optional(),
    })
    .optional(),
  verifiedLinks: z
    .array(z.strictObject({ ref: entityRefSchema, sourceRefs: internalSources.min(1) }))
    .max(100)
    .optional(),
});
export const recordSnapshotSchema = z.strictObject({
  ref: taskParentSchema,
  fields: z.array(factSchema).max(500),
  lastWritten: z.array(factSchema).max(500).optional(),
  lockedFields: z.array(safeField).max(100).optional(),
});
export const dealSnapshotSchema = z.strictObject({
  ref: existingDeal,
  demandId: key.optional(),
  revision: key,
  status: z.enum(['open', 'won', 'lost']),
  funnelId: crmIdSchema,
  stageId: crmIdSchema,
  stage: stageKeySchema,
  fields: z.array(factSchema).max(500),
  lastWritten: z.array(factSchema).max(500).optional(),
  lockedFields: z.array(safeField).max(100).optional(),
});
export const workflowSnapshotSchema = z.strictObject({
  conversations: z.array(conversationSnapshotSchema).max(100),
  candidates: customerCandidatesSchema,
  catalog: catalogSnapshotSchema,
  sourceRefs: internalSources.optional(),
  records: z.array(recordSnapshotSchema).max(1000).optional(),
  deals: z.array(dealSnapshotSchema).max(1000).optional(),
});
export const preparedWorkSchema = z.strictObject({
  workId: key,
  leaseToken: key,
  expiresAt: date,
  snapshotVersion: version,
  contextVersion: z.number().int().min(0),
  customerId: key,
  markdown: z.string().max(32768),
  snapshot: workflowSnapshotSchema,
  catalogVersion: key,
  coverage: coverageSchema,
  reviewDecision: z.strictObject({ reviewId: key, version, decision: reviewDecisionSchema }).optional(),
});

export type WorkTarget = z.infer<typeof workTargetSchema>;
export type PrepareInput = z.infer<typeof prepareInputSchema>;
export type CustomerCandidate = z.infer<typeof customerCandidateSchema>;
export type CustomerCandidates = z.infer<typeof customerCandidatesSchema>;
export type DealSnapshot = z.infer<typeof dealSnapshotSchema>;
export type PreparedWork = z.infer<typeof preparedWorkSchema>;
