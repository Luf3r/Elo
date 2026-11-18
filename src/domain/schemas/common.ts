import { z } from 'zod';
import {
  crmIdSchema,
  customFieldValueSchema,
  entityRefSchema,
  taskParentSchema,
} from '../../shared/contracts/crm-mutations';
import { positiveId } from '../../shared/contracts/crm-updates';
import { stageKeySchema } from '../policy-types';

export { entityRefSchema, taskParentSchema, stageKeySchema };

export const key = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((v) => !['__proto__', 'prototype', 'constructor'].includes(v));
export const version = positiveId;
export const date = z.iso.datetime({ offset: true });
export const safeField = z
  .string()
  .min(1)
  .max(150)
  .refine((v) => !v.split('.').some((p) => ['__proto__', 'prototype', 'constructor'].includes(p)));
export const reasons = z.array(key).max(100);
export const existingOrganization = z.strictObject({ kind: z.literal('organization'), id: crmIdSchema });
export const existingPerson = z.strictObject({ kind: z.literal('person'), id: crmIdSchema });
export const existingDeal = z.strictObject({ kind: z.literal('deal'), id: crmIdSchema });

export const sourceRefSchema = z.strictObject({
  kind: z.enum(['message', 'contact', 'crm', 'operator']),
  id: key,
  revision: key,
  field: safeField.optional(),
});
// This schema is the public submission boundary. Operator sources exist only in
// backend review/plan contracts, never in an agent-supplied analysis.
export const submittedSourceRefSchema = sourceRefSchema.extend({ kind: z.enum(['message', 'contact', 'crm']) });
export const sources = z.array(submittedSourceRefSchema).min(1).max(100);
export const internalSources = z.array(sourceRefSchema).max(1000);
export const factValueSchema = customFieldValueSchema;

const factFields = {
  organization: new Set([
    'name',
    'legalName',
    'cnpj',
    'email',
    'phone',
    'website',
    'description',
    'ranking',
    'leadOrigin',
    'category',
    'sector',
  ]),
  person: new Set(['cpf', 'name', 'role', 'email', 'phone', 'organization', 'description', 'birthday', 'ranking']),
  demand: new Set(['service', 'scope', 'title', 'description', 'value', 'startTime', 'ownerUser']),
};
const factObject = z.strictObject({
  entity: z.enum(['organization', 'person', 'demand']),
  clientKey: key.optional(),
  field: safeField,
  value: factValueSchema,
  sources: internalSources.min(1),
  certainty: z.enum(['confirmed', 'ambiguous']),
});
const allowedFactField = (v: z.infer<typeof factObject>) =>
  factFields[v.entity].has(v.field) || /^customFields\.[a-zA-Z0-9_-]+$/.test(v.field);
export const factSchema = factObject.refine(allowedFactField, 'Unsupported fact field.');
export const submittedFactSchema = factObject.extend({ sources }).refine(allowedFactField, 'Unsupported fact field.');

export type EntityRef = z.infer<typeof entityRefSchema>;
export type TaskParent = z.infer<typeof taskParentSchema>;
export type StageKey = z.infer<typeof stageKeySchema>;
export type SourceRef = z.infer<typeof sourceRefSchema>;
export type FactValue = z.infer<typeof factValueSchema>;
export type Fact = z.infer<typeof factSchema>;
