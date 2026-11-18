import { createOrganizationSchema, createPersonSchema } from '../shared/contracts/crm-mutations';
import type { CatalogSnapshot } from '../shared/contracts/crm';
import type { AgentAnalysis } from './schemas/analysis';
import type { CustomerResolution } from './schemas/planning';
import type { CustomerCandidate, CustomerCandidates } from './schemas/snapshot';
import { normalizedPhone, sameEntity, uniqueSources } from './identity-candidates';

export { readDuplicateCandidates } from './identity-duplicates';
export {
  sameEntity,
  uniqueSources,
  normalizedPhone,
  readCustomerCandidates,
  candidateLookupLinks,
  type CandidateCrmReader,
} from './identity-candidates';

const name = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
const email = (value: string) => value.trim().toLowerCase();
const document = (value: string) => value.replace(/\D/g, '');

/** Agent selection is a claim checked against server-read evidence, never authority. */
export function resolveCustomer(
  input: AgentAnalysis,
  candidates: CustomerCandidates,
  _catalog: CatalogSnapshot,
): CustomerResolution {
  const sourceRefs = uniqueSources([
    ...input.facts.flatMap((f) => f.sources),
    ...candidates.candidates.flatMap((c) => c.sourceRefs),
    ...(candidates.verifiedLinks ?? []).flatMap((l) => l.sourceRefs),
  ]);
  const review = (...reviewReasons: string[]): CustomerResolution => ({ kind: 'review', sourceRefs, reviewReasons });
  if (candidates.crmContactLink?.status === 'verified' && input.customerSelection.kind === 'person') {
    const linked = candidates.candidates.find(
      (c) => c.ref.kind === 'person' && c.ref.id === candidates.crmContactLink!.crmPersonId,
    );
    if (!linked || input.customerSelection.id !== linked.ref.id) return review('CUSTOMER_SELECTION_CONFLICT');
    return {
      kind: 'resolved',
      customerId: candidates.customerId ?? crypto.randomUUID(),
      ref: linked.ref,
      sourceRefs,
      reviewReasons: [],
    };
  }
  if (
    candidates.candidateRead?.status === 'verified' &&
    candidates.coverage.complete &&
    input.customerSelection.kind === 'person'
  ) {
    const winner = candidates.candidates.find(
      (c) => c.ref.kind === 'person' && c.ref.id === candidates.candidateRead!.selectedPersonId,
    );
    if (!winner || winner.ref.id !== input.customerSelection.id) return review('CUSTOMER_SELECTION_CONFLICT');
    return {
      kind: 'resolved',
      customerId: candidates.customerId ?? crypto.randomUUID(),
      ref: winner.ref,
      sourceRefs,
      reviewReasons: [],
    };
  }
  if (
    input.customerSelection.kind === 'new' &&
    input.customerSelection.entity === 'person' &&
    candidates.crmContactLink
  )
    return review('CHAT_PERSON_CREATION_REQUIRES_REVIEW');
  if (!candidates.coverage.complete || candidates.coverage.missingReasons.length)
    return review('CANDIDATE_COVERAGE_INCOMPLETE');
  if (input.ambiguities.some((a) => !a.clientKey)) return review('CUSTOMER_AMBIGUOUS');
  const selection = input.customerSelection;
  const entity = selection.kind === 'new' ? selection.entity : selection.kind;
  const facts = input.facts.filter((f) => f.entity === entity);
  if (
    facts.some(
      (f) => f.certainty !== 'confirmed' && ['name', 'cnpj', 'email', 'phone', 'organization'].includes(f.field),
    )
  )
    return review('IDENTITY_FACT_AMBIGUOUS');
  const value = (field: string) => {
    const values = facts.filter((f) => f.field === field && f.certainty === 'confirmed').map((f) => f.value);
    return values.length && values.every((v) => v === values[0]) ? values[0] : undefined;
  };
  for (const field of ['name', 'cnpj', 'email', 'phone', 'organization'])
    if (new Set(facts.filter((f) => f.field === field).map((f) => JSON.stringify(f.value))).size > 1)
      return review('IDENTITY_FACT_CONFLICT');
  const pool = candidates.candidates.filter((c) => c.ref.kind === entity);
  if (selection.kind !== 'new' && !pool.some((c) => sameEntity(c.ref, selection)))
    return review('CUSTOMER_ABSENT_FROM_SNAPSHOT');
  const links = (candidates.verifiedLinks ?? []).filter((l) => l.ref.kind === entity);
  if (links.some((l) => !pool.some((c) => sameEntity(c.ref, l.ref)))) return review('CRM_LINK_UNVERIFIED');
  const linked = pool.filter((c) => links.some((l) => sameEntity(c.ref, l.ref)));
  const doc = value('cnpj');
  const mail = value('email');
  const phone = value('phone');
  const customerName = value('name');
  // General contact-search coverage cannot prove that a document was searched.
  // Facts can arrive after a snapshot; require a new, complete identifier read.
  if (
    entity === 'organization' &&
    typeof doc === 'string' &&
    (document(doc).length !== 14 ||
      !candidates.identifierCoverage?.some(
        (lookup) =>
          lookup.entity === entity &&
          lookup.field === 'cnpj' &&
          lookup.value === document(doc) &&
          lookup.coverage.complete &&
          !lookup.coverage.missingReasons.length &&
          lookup.coverage.pagesRead > 0,
      ))
  )
    return review('IDENTIFIER_COVERAGE_INCOMPLETE');
  const docMatches =
    typeof doc === 'string' && document(doc).length === 14
      ? pool.filter((c) => c.document && document(c.document) === document(doc))
      : [];
  const mailMatches = typeof mail === 'string' ? pool.filter((c) => c.email && email(c.email) === email(mail)) : [];
  const phoneMatches =
    typeof phone === 'string' && normalizedPhone(phone)
      ? pool.filter((c) => c.phone && normalizedPhone(c.phone) === normalizedPhone(phone))
      : [];
  const names = typeof customerName === 'string' ? pool.filter((c) => name(c.name) === name(customerName)) : [];
  const tiers = [linked, docMatches, mailMatches, phoneMatches];
  if (tiers.some((tier) => tier.length > 1)) return review('DUPLICATE_IDENTITY');
  const winners = tiers.flat();
  if (winners.some((c) => !sameEntity(c.ref, winners[0]!.ref))) return review('IDENTITY_EVIDENCE_CONFLICT');
  const winner: CustomerCandidate | undefined = winners[0];
  if (winner) {
    if (selection.kind === 'new' || !sameEntity(selection, winner.ref)) return review('CUSTOMER_SELECTION_CONFLICT');
    if (!linked.length && !docMatches.length && !names.some((c) => sameEntity(c.ref, winner.ref)))
      return review('CONTACT_CONTEXT_REQUIRED');
    if (typeof doc === 'string' && winner.document && document(doc) !== document(winner.document))
      return review('IDENTITY_EVIDENCE_CONFLICT');
    const organization = value('organization');
    if (entity === 'person' && typeof organization === 'number' && !winner.organizationIds.includes(organization))
      return review('PERSON_ORGANIZATION_LINK_UNVERIFIED');
    return {
      kind: 'resolved',
      customerId: candidates.customerId ?? crypto.randomUUID(),
      ref: winner.ref,
      sourceRefs,
      reviewReasons: [],
    };
  }
  if (selection.kind !== 'new' || names.length) return review('CUSTOMER_IDENTITY_UNPROVEN');
  if (typeof customerName !== 'string' || name(selection.record.name) !== name(customerName))
    return review('CUSTOMER_NAME_REQUIRED');
  const record = {
    name: customerName.trim(),
    ...(typeof doc === 'string' && entity === 'organization' ? { cnpj: doc } : {}),
    ...(typeof mail === 'string' || (typeof phone === 'string' && normalizedPhone(phone))
      ? {
          contact: {
            ...(typeof mail === 'string' ? { email: mail } : {}),
            ...(typeof phone === 'string' && normalizedPhone(phone) ? { mobile: normalizedPhone(phone) } : {}),
          },
        }
      : {}),
  };
  const parsed = (entity === 'person' ? createPersonSchema : createOrganizationSchema).safeParse(record);
  if (!parsed.success) return review('CUSTOMER_CREATE_INVALID');
  // A represented organization must be separately verified; never copied from a proposal.
  if (entity === 'person' && ('organization' in selection.record || value('organization') !== undefined))
    return review('PERSON_ORGANIZATION_LINK_UNVERIFIED');
  return {
    kind: 'create',
    customerId: candidates.customerId ?? crypto.randomUUID(),
    proposal: { kind: 'new', entity, record: parsed.data },
    sourceRefs,
    reviewReasons: [],
  };
}
