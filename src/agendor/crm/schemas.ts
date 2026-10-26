import { z } from 'zod';
import { SafeError } from '../../errors';
import type { ConfigurationInput } from './types';

export const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const pagination = {
  page: positiveId.default(1),
  perPage: z.number().int().min(1).max(100).default(20),
};
const query = z.string().trim().max(300).optional();
export const emailInput = z.strictObject({ email: z.email() });
const dateFilter = z.iso.datetime({ offset: true }).optional();
const dates = { createdAtGt: dateFilter, createdAtLt: dateFilter, updatedAtGt: dateFilter, updatedAtLt: dateFilter };
const prefix = z.string().trim().min(1).max(300).optional();
const customFields = { withCustomFields: z.boolean().optional() };
export const personOptionsInput = z.strictObject(customFields);
export const personDetailInput = z.strictObject({ id: positiveId, ...customFields });
export const peopleInput = z.strictObject({ ...pagination, query, email: z.email().optional(), phone: prefix, cpf: prefix, organizationId: positiveId.optional(), ...customFields, ...dates });
export const organizationsInput = z.strictObject({ ...pagination, query, cnpj: prefix, phone: prefix, email: prefix, exactName: prefix, ...customFields, ...dates });
export const dealsInput = z.strictObject({
  ...pagination, query, titleSearch: prefix, funnelIds: z.array(positiveId).min(1).max(100).optional(),
  stageId: positiveId.optional(), stageSequence: positiveId.optional(), ...customFields, ...dates,
  startAtGt: dateFilter, startAtLt: dateFilter, endAtGt: dateFilter, endAtLt: dateFilter,
  organizationId: positiveId.optional(), personId: positiveId.optional(), ownerId: positiveId.optional(),
  status: z.enum(['1', '2', '3']).optional().describe('Agendor dealStatus ID: 1, 2 or 3.'),
}).refine(v => v.query === undefined || v.titleSearch === undefined, 'query and titleSearch are mutually exclusive.');
export const tasksInput = z.strictObject({
  ...pagination, dealId: positiveId.optional(), personId: positiveId.optional(), organizationId: positiveId.optional(),
  updatedDateGt: z.iso.datetime({ offset: true }).describe('Required: explicit ISO 8601 lower bound within the past 31 days, including scoped entity queries.'),
}).refine(v => [v.dealId, v.personId, v.organizationId].filter(x => x !== undefined).length <= 1, {
  message: 'Provide at most one entity ID.',
}).refine(v => {
  const date = Date.parse(v.updatedDateGt);
  return date <= Date.now() && date >= Date.now() - 31 * 86_400_000;
}, {
  message: 'updatedDateGt must be within the past 31 days.',
});
export const idInput = z.strictObject({ id: positiveId });
export const updateIdInput = z.strictObject({ id: z.number().int().positive().max(2_147_483_647) });
const updateText = (max: number) => z.string().trim().max(max);
const ranking = z.number().int().min(0).max(5);
const validBirthday = (value: string) => {
  const parts = value.split('-').map(Number);
  const year = parts.length === 3 ? parts[0]! : 2000;
  const month = parts.length === 3 ? parts[1]! : parts[0]!;
  const day = parts.length === 3 ? parts[2]! : parts[1]!;
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month! >= 1 && month! <= 12 && day! >= 1 && day! <= (days[month! - 1] ?? 0);
};
const contactUpdate = z.strictObject({
  email: z.email().optional(),
  work: updateText(80).optional(),
  mobile: updateText(80).optional(),
}).refine(value => Object.keys(value).length > 0, 'Provide at least one contact field.');
function nonEmptyPatch<T extends z.ZodRawShape>(shape: T) {
  return z.strictObject(shape).refine(value => Object.keys(value).length > 0, 'Provide at least one field to update.');
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
  birthday: z.string().regex(/^(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})$/).refine(validBirthday, 'Invalid calendar date.').optional(),
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

const states = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'] as const;
export const configurationInput = z.strictObject({
  ...pagination,
  section: z.enum(['funnels', 'stages', 'customFields', 'users', 'products', 'origins', 'categories', 'sectors', 'cities']),
  entityType: z.enum(['organizations', 'people', 'deals', 'products']).optional(),
  funnelId: positiveId.optional(), state: z.enum(states).optional(),
}).superRefine((value, ctx) => {
  for (const [field, section] of [['entityType', 'customFields'], ['funnelId', 'stages'], ['state', 'cities']] as const) {
    if ((value.section === section) !== (value[field] !== undefined)) ctx.addIssue({ code: 'custom', path: [field], message: 'Required only for ' + section + '.' });
  }
  // Only products documents pagination. Never imply continuation for ignored parameters.
  if (value.section !== 'products' && (value.page !== 1 || value.perPage !== 20)) ctx.addIssue({ code: 'custom', message: 'Pagination is supported only for products.' });
});
export function parseConfiguration(value: unknown): ConfigurationInput & { page: number; perPage: number } {
  return parseInput(configurationInput, value) as ConfigurationInput & { page: number; perPage: number };
}
export const taskDetailEnvelope = z.object({ task_entity: recordSchema });
