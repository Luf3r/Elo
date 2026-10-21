import { z } from 'zod';
import { SafeError } from '../../errors';

export const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const pagination = {
  page: positiveId.default(1),
  perPage: z.number().int().min(1).max(100).default(20),
};
const query = z.string().trim().max(300).optional();
export const emailInput = z.strictObject({ email: z.email() });
export const peopleInput = z.strictObject({ ...pagination, query, email: z.email().optional() });
export const organizationsInput = z.strictObject({ ...pagination, query });
export const dealsInput = z.strictObject({
  ...pagination, query,
  organizationId: positiveId.optional(), personId: positiveId.optional(), ownerId: positiveId.optional(),
  status: z.enum(['1', '2', '3']).optional().describe('Agendor dealStatus ID: 1, 2 or 3.'),
});
export const tasksInput = z.strictObject({
  ...pagination, dealId: positiveId.optional(), personId: positiveId.optional(), organizationId: positiveId.optional(),
}).refine(v => [v.dealId, v.personId, v.organizationId].filter(x => x !== undefined).length <= 1, {
  message: 'Provide at most one entity ID.',
});
export const idInput = z.strictObject({ id: positiveId });
export const recordSchema = z.record(z.string(), z.unknown());
export const listEnvelope = z.object({
  data: z.array(recordSchema).optional(),
  items: z.array(recordSchema).optional(),
  links: z.object({ next: z.string().nullish() }).nullish(),
}).refine(v => v.data !== undefined || v.items !== undefined);
export const detailEnvelope = z.object({ data: recordSchema });

export function parseInput<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SafeError('INVALID_INPUT', 'Invalid tool arguments.', false, 400);
  return parsed.data;
}
