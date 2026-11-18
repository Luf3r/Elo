import { z } from 'zod';
import { positiveId } from '../../shared/contracts/crm-updates';
import { date, internalSources, key, taskParentSchema, version } from '../../domain/schemas/common';
import { coverageSchema, preparedWorkSchema } from '../../domain/schemas/snapshot';

export const snapshotManifestSchema = z.strictObject({
  workId: key,
  snapshotVersion: version,
  contextVersion: z.number().int().min(0),
  catalogVersion: key,
  readAt: date,
  sources: internalSources,
  messages: z
    .array(
      z.strictObject({
        conversationId: positiveId,
        id: positiveId,
        revision: key,
        hash: key,
        direction: z.enum(['incoming', 'outgoing', 'activity', 'unknown']),
        senderType: z.string().max(80).optional(),
        senderId: positiveId.optional(),
      }),
    )
    .max(10000),
  records: z.array(z.strictObject({ ref: taskParentSchema, revision: key, hash: key })).max(1000),
  coverage: coverageSchema,
});
export const preparationProgressSchema = z.strictObject({
  stage: z.enum(['conversation', 'candidates', 'catalog', 'hydration']),
  messagePages: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  attachmentPages: z.number().int().nonnegative(),
  catalogPages: z.number().int().nonnegative(),
  candidateLookups: z.number().int().nonnegative(),
  hydrated: z.number().int().nonnegative(),
});
export const prepareResultSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('ready'), work: preparedWorkSchema }),
  z.strictObject({
    state: z.literal('continue'),
    workId: key,
    continuation: key,
    leaseToken: key.optional(),
    manifest: snapshotManifestSchema,
    coverage: coverageSchema,
  }),
  z.strictObject({
    state: z.literal('deferred'),
    workId: key,
    retryAt: date,
    leaseToken: key.optional(),
    continuation: key.optional(),
    reason: key,
    progress: preparationProgressSchema,
    noProgressAttempts: z.number().int().min(1),
  }),
  z.strictObject({
    state: z.literal('blocked'),
    workId: key,
    reason: z.literal('PREPARATION_NO_PROGRESS'),
    lastReason: key,
    progress: preparationProgressSchema,
    leaseExpiresAt: date,
    recovery: z.string(),
  }),
  z.strictObject({ state: z.literal('empty') }),
  z.strictObject({ state: z.literal('review'), workId: key, reviewIds: z.array(key).min(1) }),
]);

export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;
export type PrepareResult = z.infer<typeof prepareResultSchema>;
