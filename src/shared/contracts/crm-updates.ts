import { z } from 'zod';

export const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const recordSchema = z.record(z.string(), z.unknown());

const updateText = (max: number) => z.string().trim().max(max);
const ranking = z.number().int().min(0).max(5);
const validBirthday = (value: string) => {
  const parts = value.split('-').map(Number);
  const year = parts.length === 3 ? parts[0]! : 2000;
  const month = parts.length === 3 ? parts[1]! : parts[0]!;
  const day = parts.length === 3 ? parts[2]! : parts[1]!;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0);
};
const contactUpdate = z
  .strictObject({
    email: z.email().optional(),
    work: updateText(80).optional(),
    mobile: updateText(80).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one contact field.');
function nonEmptyPatch<T extends z.ZodRawShape>(shape: T) {
  return z
    .strictObject(shape)
    .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update.');
}
export const updateDealInput = nonEmptyPatch({
  title: updateText(150).min(1).optional(),
  value: z.number().finite().min(0).max(1_000_000_000_000).optional(),
  description: updateText(2000).optional(),
  ranking: ranking.optional(),
});
export const updateDealStageInput = z.strictObject({
  dealStage: z.number().int().positive().max(2_147_483_647),
  funnel: z.number().int().positive().max(2_147_483_647).optional(),
});
export const updatePersonInput = nonEmptyPatch({
  name: updateText(150).min(1).optional(),
  role: updateText(150).optional(),
  description: updateText(700).optional(),
  birthday: z
    .string()
    .regex(/^(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})$/)
    .refine(validBirthday, 'Invalid calendar date.')
    .optional(),
  ranking: ranking.optional(),
  contact: contactUpdate.optional(),
});
export const updateOrganizationInput = nonEmptyPatch({
  name: updateText(150).min(1).optional(),
  legalName: updateText(255).optional(),
  description: updateText(700).optional(),
  website: z.url().max(2000).optional(),
  ranking: ranking.optional(),
  contact: contactUpdate.optional(),
});
