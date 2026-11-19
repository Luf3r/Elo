import { TENANT_ACCOUNT_KEY } from '../app/config/tenant';
import { createMutationSchemas, customFieldMatchesCatalog } from '../shared/contracts/crm-mutations';
import type { CatalogSnapshot } from '../shared/contracts/crm';
import { uniqueSources } from './identity';
import type { Fact } from './schemas/common';
import { fieldPatchInputSchema, type FieldPatchDecision, type FieldPatchInput } from './schemas/planning';

const START = `<!-- ${TENANT_ACCOUNT_KEY}:auto:start -->`;
const END = `<!-- ${TENANT_ACCOUNT_KEY}:auto:end -->`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function isActiveUser(catalog: CatalogSnapshot, id: unknown): id is number {
  const matches = catalog.users.filter((user) => user.id === id);
  return matches.length === 1 && matches[0]!.active === true;
}
/** Human text is never truncated. An oversized or malformed managed region is
 * a review item, leaving the observed description untouched. */
export function mergeManagedDescription(
  current: string,
  summary: string,
  limit = 2000,
): { description?: string; reviewReasons: string[] } {
  if (summary.includes(START) || summary.includes(END)) return { reviewReasons: ['DESCRIPTION_MARKER_CONFLICT'] };
  const starts = current.split(START).length - 1;
  const ends = current.split(END).length - 1;
  if (starts !== ends || starts > 1 || (starts === 1 && current.indexOf(START) > current.indexOf(END)))
    return { reviewReasons: ['DESCRIPTION_MARKER_CONFLICT'] };
  const region = `${START}\n${summary}\n${END}`;
  const description =
    starts === 1
      ? current.slice(0, current.indexOf(START)) + region + current.slice(current.indexOf(END) + END.length)
      : current + (current ? '\n\n' : '') + region;
  return description.length <= limit ? { description, reviewReasons: [] } : { reviewReasons: ['DESCRIPTION_LIMIT'] };
}

/** Only scalar, supported, evidenced facts leave this boundary. Collection
 * writes remain blocked by the Task 8 adapter contract, even on creation. */
export function buildFieldPatch(input: FieldPatchInput): FieldPatchDecision {
  const parsed = fieldPatchInputSchema.safeParse(input);
  if (!parsed.success) return { ref: input.ref, reviewReasons: ['INVALID_FIELD_INPUT'], sourceRefs: [] };
  const { ref, facts, current, catalog, policy, lastWritten = [], lockedFields = [] } = parsed.data;
  const entity = ref.kind === 'deal' ? 'demand' : ref.kind;
  const catalogEntity = ref.kind === 'deal' ? 'deals' : ref.kind === 'person' ? 'people' : 'organizations';
  const mutationSchemas = createMutationSchemas(catalog);
  const schema =
    ref.kind === 'deal'
      ? mutationSchemas.enrichDeal
      : ref.kind === 'person'
        ? mutationSchemas.enrichPerson
        : mutationSchemas.enrichOrganization;
  const patch: Record<string, unknown> = {};
  const reviewReasons: string[] = [];
  const sourceRefs: Fact['sources'] = [];
  const grouped = new Map<string, Fact[]>();
  for (const fact of facts.filter((f) => f.entity === entity))
    grouped.set(fact.field, [...(grouped.get(fact.field) ?? []), fact]);
  for (const [field, candidates] of grouped) {
    if (candidates.some((f) => f.certainty !== 'confirmed')) {
      reviewReasons.push(`FACT_AMBIGUOUS:${field}`);
      continue;
    }
    if (new Set(candidates.map((f) => JSON.stringify(f.value))).size > 1) {
      reviewReasons.push(`FACT_CONFLICT:${field}`);
      continue;
    }
    const fact = candidates[0]!;
    const value = fact.value;
    // Unknown never becomes a clearing operation, zero, empty list or string.
    if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    const observed = current.filter((f) => f.entity === entity && f.field === field);
    if (observed.length > 1 && !observed.every((f) => same(f.value, observed[0]!.value))) {
      reviewReasons.push(`CURRENT_FIELD_CONFLICT:${field}`);
      continue;
    }
    const old = observed[0];
    if (old && same(old.value, value)) continue;
    if (lockedFields.includes(field)) {
      reviewReasons.push(`FIELD_LOCKED:${field}`);
      continue;
    }
    if (field === 'ownerUser') {
      if (old && old.value !== null && old.value !== '') continue;
      if (!isActiveUser(catalog, value)) {
        reviewReasons.push('OWNER_UNVERIFIED');
        continue;
      }
    }
    if (field.startsWith('customFields.')) {
      const logical = field.slice(13);
      const mapping = policy?.customFieldMapping.filter((m) => m.entity === catalogEntity && m.field === logical) ?? [];
      if (mapping.length !== 1) {
        reviewReasons.push(`CUSTOM_FIELD_MAPPING_MISSING:${logical}`);
        continue;
      }
      if (!customFieldMatchesCatalog({ id: mapping[0]!.catalogFieldId, value }, catalogEntity, catalog)) {
        reviewReasons.push(`INVALID_CUSTOM_FIELD:${logical}`);
        continue;
      }
      reviewReasons.push('COLLECTION_WRITE_UNVERIFIED');
      continue;
    }
    if (['service', 'scope'].includes(field)) continue;
    if (old && old.value !== null && old.value !== '' && field !== 'description') {
      const previous = lastWritten.filter((f) => f.entity === entity && f.field === field);
      if (previous.length !== 1 || !same(previous[0]!.value, old.value)) {
        reviewReasons.push(`EXTERNAL_CHANGE:${field}`);
        continue;
      }
    }
    let partial: Record<string, unknown>;
    if (field === 'description') {
      if (typeof value !== 'string' || (old && old.value !== null && typeof old.value !== 'string')) {
        reviewReasons.push('INVALID_FIELD:description');
        continue;
      }
      const previous = lastWritten.find((f) => f.entity === entity && f.field === field);
      const region = (v: unknown) =>
        typeof v === 'string' && v.includes(START) ? v.slice(v.indexOf(START), v.indexOf(END) + END.length) : undefined;
      if (previous && region(previous.value) !== region(old?.value)) {
        reviewReasons.push('EXTERNAL_CHANGE:description');
        continue;
      }
      const managed = mergeManagedDescription(
        typeof old?.value === 'string' ? old.value : '',
        value,
        ref.kind === 'deal' ? 2000 : 700,
      );
      reviewReasons.push(...managed.reviewReasons);
      if (!managed.description) continue;
      partial = { description: managed.description };
    } else if (field === 'email' || field === 'phone') {
      const contact = patch.contact as Record<string, unknown> | undefined;
      partial = { contact: { ...contact, [field === 'email' ? 'email' : 'mobile']: value } };
    } else partial = { [field]: value };
    if (!schema.safeParse(partial).success) {
      reviewReasons.push(`INVALID_FIELD:${field}`);
      continue;
    }
    Object.assign(patch, partial);
    sourceRefs.push(...candidates.flatMap((f) => f.sources));
  }
  return {
    ref,
    ...(Object.keys(patch).length ? { patch: schema.parse(patch) } : {}),
    reviewReasons: [...new Set(reviewReasons)],
    sourceRefs: uniqueSources(sourceRefs),
  };
}
