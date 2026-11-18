import { z } from 'zod';
import { crmIdSchema } from '../../shared/contracts/crm-mutations';
import { date, key, reasons, safeField, version } from '../../domain/schemas/common';
import {
  actorSchema,
  authorizedPlanSchema,
  crmRefSchema,
  mutationCommandSchema,
  workLeaseSchema,
} from '../../domain/schemas/planning';
import { workTargetSchema } from '../../domain/schemas/snapshot';

export const operationReceiptSchema = z.strictObject({
  operationId: key,
  commandKey: key,
  state: z.enum(['reserved', 'running', 'confirmed', 'rejected', 'uncertain', 'review']),
  crmRef: z.union([crmRefSchema, z.strictObject({ kind: z.literal('task'), id: crmIdSchema })]).optional(),
  updatedFields: z.array(safeField).max(100),
  checkedAt: date.optional(),
});
export const operationStatusSchema = z.strictObject({
  operationId: key,
  state: z.enum(['queued', 'running', 'applied', 'review', 'uncertain', 'authorization_expired']),
  receipts: z.array(operationReceiptSchema).max(100),
  pendingReasons: z.array(key).max(100),
});
export const reserveWorkInputSchema = z.strictObject({
  requestId: key,
  target: workTargetSchema,
  mode: z.enum(['preview', 'apply']),
  actor: actorSchema,
  payloadDigest: key,
});
export const budgetTicketSchema = z.discriminatedUnion('allowed', [
  z.strictObject({ allowed: z.literal(true), reservationId: key }),
  z.strictObject({ allowed: z.literal(false), retryAt: z.number().finite().min(0) }),
]);
export const snapshotVersionSchema = z.strictObject({
  snapshotVersion: version,
  contextVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  catalogVersion: key,
});
export const planBasisSchema = snapshotVersionSchema.extend({ lease: workLeaseSchema, customerId: key });
export const commandReservationSchema = planBasisSchema.extend({
  operationId: key,
  command: mutationCommandSchema,
  authorization: authorizedPlanSchema,
  expectedVersion: version,
  payloadDigest: key,
});
export const reservationResultSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('reserved'), version, fence: version }),
  z.strictObject({ state: z.literal('busy'), version }),
  z.strictObject({ state: z.literal('already_confirmed'), version, receipt: operationReceiptSchema }),
  z.strictObject({ state: z.literal('uncertain'), version, receipt: operationReceiptSchema }),
  z.strictObject({ state: z.literal('review'), version, reviewReasons: reasons }),
]);
export const commandCompletionSchema = z.strictObject({
  operationId: key,
  commandKey: key,
  fence: version,
  expectedVersion: version,
  receipt: operationReceiptSchema,
});
export const reconciliationResultSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('confirmed'), receipt: operationReceiptSchema }),
  z.strictObject({ state: z.literal('uncertain'), reviewReasons: reasons }),
  z.strictObject({ state: z.literal('review'), reviewReasons: reasons }),
]);

export type OperationReceipt = z.infer<typeof operationReceiptSchema>;
export type OperationStatus = z.infer<typeof operationStatusSchema>;
export type ReserveWorkInput = z.infer<typeof reserveWorkInputSchema>;
export type BudgetTicket = z.infer<typeof budgetTicketSchema>;
export type PlanBasis = z.infer<typeof planBasisSchema>;
export type CommandReservation = z.infer<typeof commandReservationSchema>;
export type ReservationResult = z.infer<typeof reservationResultSchema>;
export type CommandCompletion = z.infer<typeof commandCompletionSchema>;
export type ReconciliationResult = z.infer<typeof reconciliationResultSchema>;
