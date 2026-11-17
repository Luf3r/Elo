import {BudgetDeferredError} from './state/budget';
export { readDuplicateCandidates } from './identity-duplicates';
import { SafeError } from '../errors';
import type { AgentAnalysis, CatalogSnapshot, CustomerCandidate, CustomerCandidates, CustomerResolution, EntityRef, SourceRef } from './types';
import { createOrganizationSchema, createPersonSchema } from '../agendor/crm/mutation-schemas';
import type { AgendorCrmClient, PagedResult } from '../agendor/crm/types';
import type { ChatContact } from '../agendor/chat/types';

export const sameEntity = (a: EntityRef, b: EntityRef) => a.kind === b.kind && a.id === b.id;
export function uniqueSources(refs: readonly SourceRef[]): SourceRef[] {
  return [...new Map(refs.map(ref => [JSON.stringify([ref.kind, ref.id, ref.revision, ref.field]), ref])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
const name = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
const email = (value: string) => value.trim().toLowerCase();
const document = (value: string) => value.replace(/\D/g, '');
// Require an explicit international prefix; a local number never gains a country/DDD.
export const normalizedPhone = (value: string): string | undefined => {
  const clean = value.trim().replace(/[\s().-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(clean) ? clean : undefined;
};

/** Agent selection is a claim checked against server-read evidence, never authority. */
export function resolveCustomer(input: AgentAnalysis, candidates: CustomerCandidates, _catalog: CatalogSnapshot): CustomerResolution {
  const sourceRefs = uniqueSources([...input.facts.flatMap(f => f.sources), ...candidates.candidates.flatMap(c => c.sourceRefs), ...(candidates.verifiedLinks ?? []).flatMap(l => l.sourceRefs)]);
  const review = (...reviewReasons: string[]): CustomerResolution => ({ kind: 'review', sourceRefs, reviewReasons });
  if (candidates.crmContactLink?.status === 'verified' && input.customerSelection.kind === 'person') {
    const linked = candidates.candidates.find(c => c.ref.kind === 'person' && c.ref.id === candidates.crmContactLink!.crmPersonId);
    if (!linked || input.customerSelection.id !== linked.ref.id) return review('CUSTOMER_SELECTION_CONFLICT');
    return { kind:'resolved',customerId:candidates.customerId ?? crypto.randomUUID(),ref:linked.ref,sourceRefs,reviewReasons:[] };
  }
  if (candidates.candidateRead?.status==='verified' && candidates.coverage.complete && input.customerSelection.kind==='person') {
    const winner=candidates.candidates.find(c=>c.ref.kind==='person' && c.ref.id===candidates.candidateRead!.selectedPersonId);
    if (!winner || winner.ref.id!==input.customerSelection.id) return review('CUSTOMER_SELECTION_CONFLICT');
    return {kind:'resolved',customerId:candidates.customerId ?? crypto.randomUUID(),ref:winner.ref,sourceRefs,reviewReasons:[]};
  }
  if (input.customerSelection.kind === 'new' && input.customerSelection.entity === 'person' && candidates.crmContactLink) return review('CHAT_PERSON_CREATION_REQUIRES_REVIEW');
  if (!candidates.coverage.complete || candidates.coverage.missingReasons.length) return review('CANDIDATE_COVERAGE_INCOMPLETE');
  if (input.ambiguities.some(a => !a.clientKey)) return review('CUSTOMER_AMBIGUOUS');
  const selection = input.customerSelection;
  const entity = selection.kind === 'new' ? selection.entity : selection.kind;
  const facts = input.facts.filter(f => f.entity === entity);
  if (facts.some(f => f.certainty !== 'confirmed' && ['name', 'cnpj', 'email', 'phone', 'organization'].includes(f.field))) return review('IDENTITY_FACT_AMBIGUOUS');
  const value = (field: string) => {
    const values = facts.filter(f => f.field === field && f.certainty === 'confirmed').map(f => f.value);
    return values.length && values.every(v => v === values[0]) ? values[0] : undefined;
  };
  for (const field of ['name', 'cnpj', 'email', 'phone', 'organization']) if (new Set(facts.filter(f => f.field === field).map(f => JSON.stringify(f.value))).size > 1) return review('IDENTITY_FACT_CONFLICT');
  const pool = candidates.candidates.filter(c => c.ref.kind === entity);
  if (selection.kind !== 'new' && !pool.some(c => sameEntity(c.ref, selection))) return review('CUSTOMER_ABSENT_FROM_SNAPSHOT');
  const links = (candidates.verifiedLinks ?? []).filter(l => l.ref.kind === entity);
  if (links.some(l => !pool.some(c => sameEntity(c.ref, l.ref)))) return review('CRM_LINK_UNVERIFIED');
  const linked = pool.filter(c => links.some(l => sameEntity(c.ref, l.ref)));
  const doc = value('cnpj'); const mail = value('email'); const phone = value('phone'); const customerName = value('name');
  // General contact-search coverage cannot prove that a document was searched.
  // Facts can arrive after a snapshot; require a new, complete identifier read.
  if (entity === 'organization' && typeof doc === 'string' && (document(doc).length !== 14 || !candidates.identifierCoverage?.some(lookup => lookup.entity === entity && lookup.field === 'cnpj' && lookup.value === document(doc) && lookup.coverage.complete && !lookup.coverage.missingReasons.length && lookup.coverage.pagesRead > 0))) return review('IDENTIFIER_COVERAGE_INCOMPLETE');
  const docMatches = typeof doc === 'string' && document(doc).length === 14 ? pool.filter(c => c.document && document(c.document) === document(doc)) : [];
  const mailMatches = typeof mail === 'string' ? pool.filter(c => c.email && email(c.email) === email(mail)) : [];
  const phoneMatches = typeof phone === 'string' && normalizedPhone(phone) ? pool.filter(c => c.phone && normalizedPhone(c.phone) === normalizedPhone(phone)) : [];
  const names = typeof customerName === 'string' ? pool.filter(c => name(c.name) === name(customerName)) : [];
  const tiers = [linked, docMatches, mailMatches, phoneMatches];
  if (tiers.some(tier => tier.length > 1)) return review('DUPLICATE_IDENTITY');
  const winners = tiers.flat();
  if (winners.some(c => !sameEntity(c.ref, winners[0]!.ref))) return review('IDENTITY_EVIDENCE_CONFLICT');
  const winner: CustomerCandidate | undefined = winners[0];
  if (winner) {
    if (selection.kind === 'new' || !sameEntity(selection, winner.ref)) return review('CUSTOMER_SELECTION_CONFLICT');
    if (!linked.length && !docMatches.length && (!names.some(c => sameEntity(c.ref, winner.ref)))) return review('CONTACT_CONTEXT_REQUIRED');
    if (typeof doc === 'string' && winner.document && document(doc) !== document(winner.document)) return review('IDENTITY_EVIDENCE_CONFLICT');
    const organization = value('organization');
    if (entity === 'person' && typeof organization === 'number' && !winner.organizationIds.includes(organization)) return review('PERSON_ORGANIZATION_LINK_UNVERIFIED');
    return { kind: 'resolved', customerId: candidates.customerId ?? crypto.randomUUID(), ref: winner.ref, sourceRefs, reviewReasons: [] };
  }
  if (selection.kind !== 'new' || names.length) return review('CUSTOMER_IDENTITY_UNPROVEN');
  if (typeof customerName !== 'string' || name(selection.record.name) !== name(customerName)) return review('CUSTOMER_NAME_REQUIRED');
  const record = { name: customerName.trim(), ...(typeof doc === 'string' && entity === 'organization' ? { cnpj: doc } : {}), ...(typeof mail === 'string' || (typeof phone === 'string' && normalizedPhone(phone)) ? { contact: { ...(typeof mail === 'string' ? { email: mail } : {}), ...(typeof phone === 'string' && normalizedPhone(phone) ? { mobile: normalizedPhone(phone) } : {}) } } : {}) };
  const parsed = (entity === 'person' ? createPersonSchema : createOrganizationSchema).safeParse(record);
  if (!parsed.success) return review('CUSTOMER_CREATE_INVALID');
  // A represented organization must be separately verified; never copied from a proposal.
  if (entity === 'person' && ('organization' in selection.record || value('organization') !== undefined)) return review('PERSON_ORGANIZATION_LINK_UNVERIFIED');
  return { kind: 'create', customerId: candidates.customerId ?? crypto.randomUUID(), proposal: { kind: 'new', entity, record: parsed.data }, sourceRefs, reviewReasons: [] };
}

/** Read-only, bounded collection. Any missing page is explicit and blocks absence claims. */
export async function readCustomerCandidates(crm: Pick<AgendorCrmClient, 'searchPeople' | 'searchOrganizations' | 'getPerson'>, contact: ChatContact, revision: string, facts: readonly AgentAnalysis['facts'][number][] = []): Promise<CustomerCandidates> {
  const result: CustomerCandidates = { candidates: [], verifiedLinks: [], identifierCoverage: [], coverage: { complete: false, pagesRead: 0, missingReasons: [] } };
  const reasons = new Set<string>();
  const parsed = new Map<string, CustomerCandidate>();
  const object = (raw: unknown): Record<string, unknown> => raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const add = async (raw: unknown, kind: EntityRef['kind']): Promise<CustomerCandidate | undefined> => {
    const record = object(raw); const id = record.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || typeof record.name !== 'string' || !record.name.trim()) { reasons.add('candidate_record_invalid'); return; }
    if(parsed.size>=1000 && !parsed.has(`${kind}:${id}`)){reasons.add('candidate_limit_reached');return;}
    const ref: EntityRef = { kind, id };
    const contactRecord = object(record.contact);
    const organization = typeof record.organization === 'number' ? record.organization : object(record.organization).id;
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(record)));
    const candidate: CustomerCandidate = { ref, name: record.name, organizationIds: typeof organization === 'number' && Number.isSafeInteger(organization) && organization > 0 ? [organization] : [], sourceRefs: [{ kind: 'crm', id: `${kind}:${id}`, revision: [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('') }], ...(typeof record.cnpj === 'string' || typeof record.cpf === 'string' ? { document: (record.cnpj ?? record.cpf) as string } : {}), ...(typeof contactRecord.email === 'string' ? { email: contactRecord.email } : {}), ...(typeof contactRecord.mobile === 'string' || typeof contactRecord.work === 'string' ? { phone: (contactRecord.mobile ?? contactRecord.work) as string } : {}) };
    const previous = parsed.get(`${kind}:${id}`);
    if (previous && JSON.stringify(previous) !== JSON.stringify(candidate)) reasons.add('candidate_revision_changed');
    parsed.set(`${kind}:${id}`, candidate); return candidate;
  };
  const read = async (kind: EntityRef['kind'], load: (page: number) => Promise<PagedResult<unknown>>) => {
    const coverage = { complete: false, pagesRead: 0, missingReasons: [] as string[] };
    const finish = (complete: boolean, reason?: string) => {
      if (reason) { reasons.add(reason); coverage.missingReasons.push(reason); }
      coverage.missingReasons=[...new Set(coverage.missingReasons)];
      coverage.complete = complete && coverage.missingReasons.length === 0; return coverage;
    };
    let page = 1; const seen = new Set<number>();
    for (let count = 0; count < 10; count++) {
      if (seen.has(page)) return finish(false, 'candidate_cursor_repeated'); seen.add(page);
      let response: PagedResult<unknown>;
      try { response = await load(page); } catch (error) { if (error instanceof SafeError && (error.retryable || error.code === 'MCP_UNAUTHORIZED')) throw error; return finish(false, 'candidate_query_failed'); }
      result.coverage.pagesRead++; coverage.pagesRead++;
      if (response.pageInfo.page !== page || !Array.isArray(response.items) || response.items.length > 100) return finish(false, 'candidate_page_invalid');
      for (const record of response.items) if (!await add(record, kind)) coverage.missingReasons.push('candidate_record_invalid');
      if (!response.pageInfo.hasNext) return response.pageInfo.nextPage === null ? finish(true) : finish(false, 'candidate_cursor_invalid');
      const next = response.pageInfo.nextPage;
      if (!next || !Number.isSafeInteger(next) || next <= page) return finish(false, 'candidate_cursor_invalid');
      page = next;
    }
    return finish(false, 'candidate_page_limit');
  };
  // Native identity is authoritative. Recovery searches are only for missing/stale links.
  if (contact.crmPersonId) {
    result.crmContactLink = { status: 'query_failed', chatContactId: contact.id, crmPersonId: contact.crmPersonId };
    try {
      const record = await crm.getPerson(contact.crmPersonId);
      if (object(record).id !== contact.crmPersonId) reasons.add('crm_contact_link_identity_mismatch');
      else {
        const person = await add(record, 'person');
        if (person) {
          result.verifiedLinks!.push({ ref: person.ref, sourceRefs: [{ kind: 'contact', id: String(contact.id), revision }, ...person.sourceRefs] });
          result.crmContactLink = { status: 'verified', chatContactId: contact.id, crmPersonId: contact.crmPersonId, method: 'direct_agendor_link' };
          result.candidateRead = { status: 'not_needed' };
          result.duplicateCheck = { status: 'not_checked', currentPersonId: contact.crmPersonId };
          result.candidates = [...parsed.values()]; result.coverage = { complete: true, pagesRead: 1, missingReasons: [] };
          return result;
        }
      }
    } catch (error) {
      if(error instanceof BudgetDeferredError || error instanceof SafeError && error.code === 'MCP_UNAUTHORIZED')throw error;
      if (error instanceof SafeError && error.code === 'UPSTREAM_NOT_FOUND') result.crmContactLink.status = 'stale';
      else {
        reasons.add('crm_contact_link_query_failed');
      }
    }
    if (result.crmContactLink.status === 'query_failed') {
      result.candidateRead = { status:'query_failed' }; result.coverage.missingReasons=[...reasons];
      return result;
    }
  } else result.crmContactLink = { status: 'missing', chatContactId: contact.id };
  // Each query is fixed to the supported adapter. No arbitrary URL/query surface.
  const cpf = facts.find(f=>f.entity==='person' && f.field==='cpf' && f.certainty==='confirmed' && typeof f.value==='string')?.value;
  const filters = [contact.phoneNumber ? { phone: contact.phoneNumber } : undefined, contact.email ? { email: contact.email } : undefined, typeof cpf==='string' && document(cpf).length===11 ? {cpf:document(cpf)} : undefined, contact.name ? { query: contact.name } : undefined].filter((v): v is { email: string } | { phone: string } | { query: string } | { cpf: string } => v !== undefined);
  const documents = [...new Set(facts.filter(f => f.entity === 'organization' && f.field === 'cnpj' && f.certainty === 'confirmed' && typeof f.value === 'string').map(f => document(f.value as string)))];
  if (!filters.length && !documents.length) reasons.add('contact_identity_unavailable');
  for (const filter of filters) {
    await read('person', page => crm.searchPeople({ ...filter, page, perPage: 100 }));
    if (!('cpf' in filter)) await read('organization', page => crm.searchOrganizations({ ...filter, page, perPage: 100 }));
  }
  for (const value of documents) {
    if (value.length !== 14) { reasons.add('candidate_identifier_invalid'); continue; }
    const coverage = await read('organization', page => crm.searchOrganizations({ cnpj: value, page, perPage: 100 }));
    result.identifierCoverage!.push({ entity: 'organization', field: 'cnpj', value, coverage });
  }
  result.candidates = [...parsed.values()].sort((a, b) => a.ref.kind.localeCompare(b.ref.kind) || a.ref.id - b.ref.id);
  result.coverage.missingReasons = [...reasons].sort(); result.coverage.complete = reasons.size === 0;
  const people = result.candidates.filter(c=>c.ref.kind==='person');
  const matched = (c:CustomerCandidate) => [
    ...(contact.phoneNumber && c.phone && normalizedPhone(c.phone) && normalizedPhone(c.phone)===normalizedPhone(contact.phoneNumber) ? ['exact_phone'] : []),
    ...(contact.email && c.email && email(c.email)===email(contact.email) ? ['exact_email'] : []),
    ...(typeof cpf==='string' && c.document && document(cpf)===document(c.document) ? ['exact_cpf'] : []),
  ];
  const strong=people.filter(c=>matched(c).length);
  result.candidateRead = reasons.size ? {status:'query_failed'} : strong.length>1 ? {status:'ambiguous'} : strong.length===1 ? {status:'verified',selectedPersonId:strong[0]!.ref.id,matchedBy:matched(strong[0]!)} : people.length ? {status:'ambiguous'} : {status:'no_candidate'};
  if(strong.length===1) strong[0]!.sourceRefs=uniqueSources([...strong[0]!.sourceRefs,{kind:'contact',id:String(contact.id),revision}]);
  result.duplicateCheck={status:'not_checked'};
  return result;
}

/** Recovery is sufficient to look up retained internal state, without relabeling
 * the missing/stale native link as verified. */
export function candidateLookupLinks(candidates:CustomerCandidates):NonNullable<CustomerCandidates['verifiedLinks']> {
  const links=[...(candidates.verifiedLinks ?? [])];
  if(candidates.candidateRead?.status==='verified' && candidates.coverage.complete) {
    const selected=candidates.candidates.find(c=>c.ref.kind==='person' && c.ref.id===candidates.candidateRead!.selectedPersonId);
    if(selected && !links.some(l=>sameEntity(l.ref,selected.ref)))links.push({ref:selected.ref,sourceRefs:selected.sourceRefs});
  }
  return links;
}
