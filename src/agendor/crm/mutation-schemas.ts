import { z } from 'zod';
import type { CatalogSnapshot, CatalogEntityType } from './types';

export const crmIdSchema = z.number().int().positive().max(2_147_483_647);
const safeKey = z.string().min(1).max(150).refine(v => !v.split(/[.\[\]]/).some(p => ['__proto__', 'prototype', 'constructor'].includes(p)));
const text = (max: number) => z.string().trim().max(max);
const contact = z.strictObject({ email: z.email().optional(), work: text(80).optional(), mobile: text(80).optional() }).refine(v => Object.values(v).some(x => x !== undefined));
// Explicit write-side DTO. Never pass a read-side address object through.
const address = z.strictObject({ street_name: text(150).optional(), street_number: z.int32().optional(), additional_info: text(150).optional(), district: text(100).optional(), postal_code: text(20).optional(), city: crmIdSchema.optional() });
export const customFieldValueSchema = z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null(), z.array(z.union([z.string().max(300), z.number().finite()])).max(100)]);
export const customFieldSchema = z.strictObject({ id: z.union([safeKey, crmIdSchema]), value: customFieldValueSchema });
const customFields = z.array(customFieldSchema).max(100).refine(v => new Set(v.map(f => String(f.id))).size === v.length, 'Duplicate custom field.');
const rank = z.number().int().min(0).max(5);
const companyFields = {
  name: text(150).min(1), legalName: text(255).optional(), cnpj: text(30).optional(), contact: contact.optional(), address: address.optional(),
  website: z.url().max(2000).refine(v => ['http:', 'https:'].includes(new URL(v).protocol)).optional(), description: text(700).optional(), ranking: rank.optional(),
  leadOrigin: crmIdSchema.optional(), category: crmIdSchema.optional(), sector: crmIdSchema.optional(), customFields: customFields.optional(),
};
const personFields = {
  name: text(150).min(1), role: text(150).optional(), contact: contact.optional(), organization: crmIdSchema.optional(), description: text(700).optional(),
  birthday: z.iso.date().optional(), ranking: rank.optional(), customFields: customFields.optional(),
};
export const productItemSchema = z.strictObject({ id: crmIdSchema, quantity: z.number().finite().positive(), unitValue: z.number().finite().min(0).max(1_000_000_000_000).optional(), discount: z.number().finite().min(0).max(100).optional() });
const dealFields = {
  title: text(150).min(1), description: text(2000).optional(), value: z.number().finite().min(0).max(1_000_000_000_000).optional(),
  startTime: z.iso.datetime({ offset: true }).optional(), products_entities: z.array(productItemSchema).max(100).optional(), ownerUser: crmIdSchema.optional(), customFields: customFields.optional(),
};
// OpenAPI post*Tasks/putTasks use these strings, never catalog numeric IDs.
export const taskTypeSchema = z.enum(['VISITA', 'REUNIAO', 'LIGACAO', 'EMAIL', 'PROPOSTA', 'WHATSAPP']);
const taskFields = { text: text(2000).min(1), type: taskTypeSchema, assigned_users: z.array(crmIdSchema).min(1).max(100).refine(v => new Set(v).size === v.length, 'Duplicate assignee.'), due_date: z.iso.datetime({ offset: true }) };
const patch = <T extends z.ZodRawShape>(shape: T) => z.strictObject(shape).partial().refine(v => Object.values(v).some(x => x !== undefined), 'Empty patch.');
export const entityRefSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('organization'), id: crmIdSchema }), z.strictObject({ kind: z.literal('person'), id: crmIdSchema })]);
export const taskParentSchema = z.union([entityRefSchema, z.strictObject({ kind: z.literal('deal'), id: crmIdSchema })]);
export const createOrganizationSchema = z.strictObject(companyFields);
export const createPersonSchema = z.strictObject(personFields);
export const createDealRecordSchema = z.strictObject(dealFields);
export const createTaskRecordSchema = z.strictObject(taskFields);
export const createDealSchema = z.strictObject({ parent: entityRefSchema, record: createDealRecordSchema });
export const createTaskSchema = z.strictObject({ parent: taskParentSchema, record: createTaskRecordSchema });
export const enrichOrganizationSchema = patch(companyFields);
export const enrichPersonSchema = patch(personFields);
export const enrichDealSchema = patch(dealFields);
export const updateTaskSchema = patch(taskFields);
export const changeStageSchema = z.strictObject({ funnel: crmIdSchema, dealStage: crmIdSchema });

/** Catalog validation is compulsory at the mutation adapter boundary. Unknown
 * upstream field types remain blocked until an explicit mapper is verified. */
export function customFieldMatchesCatalog(field: z.infer<typeof customFieldSchema>, entity: CatalogEntityType, catalog: CatalogSnapshot): boolean {
  const entry = catalog.customFields.find(f => f.entityType === entity && (String(f.id) === String(field.id) || f.identifier === field.id || f.name === field.id));
  if (!entry) return false;
  const optionIds = (entry.options ?? []).flatMap(o => typeof o === 'string' || typeof o === 'number' ? [o] : o && typeof o === 'object' && 'id' in o ? [(o as { id: unknown }).id] : []);
  switch (entry.type) {
    case 'text': return typeof field.value === 'string';
    case 'number': return typeof field.value === 'number' && Number.isFinite(field.value);
    case 'boolean': return typeof field.value === 'boolean';
    case 'date': return z.iso.date().safeParse(field.value).success;
    case 'select': return optionIds.some(id => id === field.value);
    case 'multiselect': return Array.isArray(field.value) && field.value.every(v => optionIds.some(id => id === v));
    default: return false;
  }
}
export function createMutationSchemas(catalog: CatalogSnapshot) {
  const knownTaskAssignees = (value: { assigned_users?: number[] }) => value.assigned_users === undefined || value.assigned_users.every(id => catalog.users.some(user => user.id === id));
  function checked<T extends z.ZodType>(schema: T, entity: CatalogEntityType) {
    return schema.superRefine((value, ctx) => {
      const fields = (value as { customFields?: z.infer<typeof customFieldSchema>[] }).customFields ?? [];
      fields.forEach((f, i) => { if (!customFieldMatchesCatalog(f, entity, catalog)) ctx.addIssue({ code: 'custom', path: ['customFields', i], message: 'Unverified custom field, type or option.' }); });
      const deal = value as { products_entities?: { id: number }[]; ownerUser?: number };
      if (entity === 'deals') {
        if (deal.ownerUser !== undefined && !catalog.users.some(u => u.id === deal.ownerUser)) ctx.addIssue({ code: 'custom', path: ['ownerUser'], message: 'Unknown user.' });
        if (deal.products_entities?.some(p => !catalog.products.some(x => x.id === p.id))) ctx.addIssue({ code: 'custom', path: ['products_entities'], message: 'Unknown product.' });
      }
    });
  }
  const checkedDealRecord = checked(createDealRecordSchema, 'deals');
  return { createOrganization: checked(createOrganizationSchema, 'organizations'), createPerson: checked(createPersonSchema, 'people'),
    createDealRecord: checkedDealRecord,
    createDeal: createDealSchema.extend({ record: checkedDealRecord }),
    createTask: createTaskSchema.extend({ record: createTaskRecordSchema.refine(knownTaskAssignees, { path: ['assigned_users'], message: 'Unknown user.' }) }),
    enrichOrganization: checked(enrichOrganizationSchema, 'organizations'), enrichPerson: checked(enrichPersonSchema, 'people'), enrichDeal: checked(enrichDealSchema, 'deals'), updateTask: updateTaskSchema.refine(knownTaskAssignees, { path: ['assigned_users'], message: 'Unknown user.' }),
    changeStage: changeStageSchema.refine(v => catalog.stages.some(s => s.sequence === v.dealStage && s.funnelId === v.funnel), 'Stage/funnel mismatch.') };
}
export type CreateOrganization = z.infer<typeof createOrganizationSchema>;
export type CreatePerson = z.infer<typeof createPersonSchema>;
export type CreateDeal = z.infer<typeof createDealSchema>;
export type CreateDealRecord = z.infer<typeof createDealRecordSchema>;
export type CreateTask = z.infer<typeof createTaskSchema>;
export type CreateTaskRecord = z.infer<typeof createTaskRecordSchema>;
export type EnrichOrganization = z.infer<typeof enrichOrganizationSchema>;
export type EnrichPerson = z.infer<typeof enrichPersonSchema>;
export type EnrichDeal = z.infer<typeof enrichDealSchema>;
export type UpdateTask = z.infer<typeof updateTaskSchema>;
export type ChangeStage = z.infer<typeof changeStageSchema>;
