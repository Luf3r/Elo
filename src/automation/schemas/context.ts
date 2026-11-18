import { z } from 'zod';
import { date, entityRefSchema, factSchema, internalSources, key, reasons, version } from '../../domain/schemas/common';
import { demandRecordSchema } from '../../domain/schemas/planning';
import { customerCandidateSchema } from '../../domain/schemas/snapshot';
import { operationReceiptSchema, planBasisSchema } from './execution';

export const customerContextSchema = z.strictObject({
  customerId: key,
  version,
  verifiedAt: date,
  markdown: z.string().refine((v) => new TextEncoder().encode(v).length <= 32768, 'Context exceeds 32 KiB.'),
  evidenceRefs: internalSources,
});
export const contextProjectionSchema = z.strictObject({
  customerId: key,
  version,
  verifiedAt: date,
  primaryRef: entityRefSchema.optional(),
  facts: z.array(factSchema).max(500),
  contacts: z.array(customerCandidateSchema).max(100),
  demands: z.array(demandRecordSchema).max(100),
  receipts: z.array(operationReceiptSchema).max(100),
  pendingReasons: reasons,
  pendingPlanIds: z.array(key).max(100).optional(),
  corrections: z
    .array(
      z
        .strictObject({ previous: factSchema, replacement: factSchema })
        .refine(
          (v) =>
            v.previous.entity === v.replacement.entity &&
            v.previous.field === v.replacement.field &&
            v.replacement.certainty === 'confirmed',
          'Correction must replace the same confirmed field.',
        ),
    )
    .max(100)
    .optional(),
});
export const contextProjectionEnvelopeSchema = z.strictObject({
  projection: contextProjectionSchema,
  basis: planBasisSchema,
});

export type CustomerContext = z.infer<typeof customerContextSchema>;
export type ContextProjection = z.infer<typeof contextProjectionSchema>;
