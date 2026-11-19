import { BudgetDeferredError, SafeError } from '../shared/errors';
import type { PagedResult, SearchOrganizationsInput, SearchPeopleInput } from '../shared/contracts/crm';
import type { ChatContact } from '../shared/contracts/chat';
import type { AgentAnalysis } from './schemas/analysis';
import type { EntityRef, SourceRef } from './schemas/common';
import type { CustomerCandidate, CustomerCandidates } from './schemas/snapshot';
import { normalizeDocument, normalizeEmail } from './normalize';

export interface CandidateCrmReader {
  getPerson(id: number): Promise<unknown>;
  searchPeople(input: SearchPeopleInput): Promise<PagedResult<unknown>>;
  searchOrganizations(input: SearchOrganizationsInput): Promise<PagedResult<unknown>>;
}

export const sameEntity = (a: EntityRef, b: EntityRef) => a.kind === b.kind && a.id === b.id;
export function uniqueSources(refs: readonly SourceRef[]): SourceRef[] {
  return [
    ...new Map(refs.map((ref) => [JSON.stringify([ref.kind, ref.id, ref.revision, ref.field]), ref])).values(),
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
// Require an explicit international prefix; a local number never gains a country/DDD.
export const normalizedPhone = (value: string): string | undefined => {
  const clean = value.trim().replace(/[\s().-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(clean) ? clean : undefined;
};

/** Read-only, bounded collection. Any missing page is explicit and blocks absence claims. */
export async function readCustomerCandidates(
  crm: CandidateCrmReader,
  contact: ChatContact,
  revision: string,
  facts: readonly AgentAnalysis['facts'][number][] = [],
): Promise<CustomerCandidates> {
  const result: CustomerCandidates = {
    candidates: [],
    verifiedLinks: [],
    identifierCoverage: [],
    coverage: { complete: false, pagesRead: 0, missingReasons: [] },
  };
  const reasons = new Set<string>();
  const parsed = new Map<string, CustomerCandidate>();
  const object = (raw: unknown): Record<string, unknown> =>
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const add = async (raw: unknown, kind: EntityRef['kind']): Promise<CustomerCandidate | undefined> => {
    const record = object(raw);
    const id = record.id;
    if (
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      typeof record.name !== 'string' ||
      !record.name.trim()
    ) {
      reasons.add('candidate_record_invalid');
      return;
    }
    if (parsed.size >= 1000 && !parsed.has(`${kind}:${id}`)) {
      reasons.add('candidate_limit_reached');
      return;
    }
    const ref: EntityRef = { kind, id };
    const contactRecord = object(record.contact);
    const organization = typeof record.organization === 'number' ? record.organization : object(record.organization).id;
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(record)));
    const candidate: CustomerCandidate = {
      ref,
      name: record.name,
      organizationIds:
        typeof organization === 'number' && Number.isSafeInteger(organization) && organization > 0
          ? [organization]
          : [],
      sourceRefs: [
        {
          kind: 'crm',
          id: `${kind}:${id}`,
          revision: [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, '0')).join(''),
        },
      ],
      ...(typeof record.cnpj === 'string' || typeof record.cpf === 'string'
        ? { document: (record.cnpj ?? record.cpf) as string }
        : {}),
      ...(typeof contactRecord.email === 'string' ? { email: contactRecord.email } : {}),
      ...(typeof contactRecord.mobile === 'string' || typeof contactRecord.work === 'string'
        ? { phone: (contactRecord.mobile ?? contactRecord.work) as string }
        : {}),
    };
    const previous = parsed.get(`${kind}:${id}`);
    if (previous && JSON.stringify(previous) !== JSON.stringify(candidate)) reasons.add('candidate_revision_changed');
    parsed.set(`${kind}:${id}`, candidate);
    return candidate;
  };
  const read = async (kind: EntityRef['kind'], load: (page: number) => Promise<PagedResult<unknown>>) => {
    const coverage = { complete: false, pagesRead: 0, missingReasons: [] as string[] };
    const finish = (complete: boolean, reason?: string) => {
      if (reason) {
        reasons.add(reason);
        coverage.missingReasons.push(reason);
      }
      coverage.missingReasons = [...new Set(coverage.missingReasons)];
      coverage.complete = complete && coverage.missingReasons.length === 0;
      return coverage;
    };
    let page = 1;
    const seen = new Set<number>();
    for (let count = 0; count < 10; count++) {
      if (seen.has(page)) return finish(false, 'candidate_cursor_repeated');
      seen.add(page);
      let response: PagedResult<unknown>;
      try {
        response = await load(page);
      } catch (error) {
        if (
          error instanceof SafeError &&
          (error.retryable || error.code === 'MCP_UNAUTHORIZED' || error.code === 'POLICY_BLOCKED')
        )
          throw error;
        return finish(false, 'candidate_query_failed');
      }
      result.coverage.pagesRead++;
      coverage.pagesRead++;
      if (response.pageInfo.page !== page || !Array.isArray(response.items) || response.items.length > 100)
        return finish(false, 'candidate_page_invalid');
      for (const record of response.items)
        if (!(await add(record, kind))) coverage.missingReasons.push('candidate_record_invalid');
      if (!response.pageInfo.hasNext)
        return response.pageInfo.nextPage === null ? finish(true) : finish(false, 'candidate_cursor_invalid');
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
          result.verifiedLinks!.push({
            ref: person.ref,
            sourceRefs: [{ kind: 'contact', id: String(contact.id), revision }, ...person.sourceRefs],
          });
          result.crmContactLink = {
            status: 'verified',
            chatContactId: contact.id,
            crmPersonId: contact.crmPersonId,
            method: 'direct_agendor_link',
          };
          result.candidateRead = { status: 'not_needed' };
          result.duplicateCheck = { status: 'not_checked', currentPersonId: contact.crmPersonId };
          result.candidates = [...parsed.values()];
          result.coverage = { complete: true, pagesRead: 1, missingReasons: [] };
          return result;
        }
      }
    } catch (error) {
      if (
        error instanceof BudgetDeferredError ||
        (error instanceof SafeError && (error.code === 'MCP_UNAUTHORIZED' || error.code === 'POLICY_BLOCKED'))
      )
        throw error;
      if (error instanceof SafeError && error.code === 'UPSTREAM_NOT_FOUND') result.crmContactLink.status = 'stale';
      else {
        reasons.add('crm_contact_link_query_failed');
      }
    }
    if (result.crmContactLink.status === 'query_failed') {
      result.candidateRead = { status: 'query_failed' };
      result.coverage.missingReasons = [...reasons];
      return result;
    }
  } else result.crmContactLink = { status: 'missing', chatContactId: contact.id };
  // Each query is fixed to the supported adapter. No arbitrary URL/query surface.
  const cpf = facts.find(
    (f) => f.entity === 'person' && f.field === 'cpf' && f.certainty === 'confirmed' && typeof f.value === 'string',
  )?.value;
  const filters = [
    contact.phoneNumber ? { phone: contact.phoneNumber } : undefined,
    contact.email ? { email: contact.email } : undefined,
    typeof cpf === 'string' && normalizeDocument(cpf).length === 11 ? { cpf: normalizeDocument(cpf) } : undefined,
    contact.name ? { query: contact.name } : undefined,
  ].filter((v): v is { email: string } | { phone: string } | { query: string } | { cpf: string } => v !== undefined);
  const documents = [
    ...new Set(
      facts
        .filter(
          (f) =>
            f.entity === 'organization' &&
            f.field === 'cnpj' &&
            f.certainty === 'confirmed' &&
            typeof f.value === 'string',
        )
        .map((f) => normalizeDocument(f.value as string)),
    ),
  ];
  if (!filters.length && !documents.length) reasons.add('contact_identity_unavailable');
  for (const filter of filters) {
    await read('person', (page) => crm.searchPeople({ ...filter, page, perPage: 100 }));
    if (!('cpf' in filter))
      await read('organization', (page) => crm.searchOrganizations({ ...filter, page, perPage: 100 }));
  }
  for (const value of documents) {
    if (value.length !== 14) {
      reasons.add('candidate_identifier_invalid');
      continue;
    }
    const coverage = await read('organization', (page) => crm.searchOrganizations({ cnpj: value, page, perPage: 100 }));
    result.identifierCoverage!.push({ entity: 'organization', field: 'cnpj', value, coverage });
  }
  result.candidates = [...parsed.values()].sort((a, b) => a.ref.kind.localeCompare(b.ref.kind) || a.ref.id - b.ref.id);
  result.coverage.missingReasons = [...reasons].sort();
  result.coverage.complete = reasons.size === 0;
  const people = result.candidates.filter((c) => c.ref.kind === 'person');
  const matched = (c: CustomerCandidate) => [
    ...(contact.phoneNumber &&
    c.phone &&
    normalizedPhone(c.phone) &&
    normalizedPhone(c.phone) === normalizedPhone(contact.phoneNumber)
      ? ['exact_phone']
      : []),
    ...(contact.email && c.email && normalizeEmail(c.email) === normalizeEmail(contact.email) ? ['exact_email'] : []),
    ...(typeof cpf === 'string' && c.document && normalizeDocument(cpf) === normalizeDocument(c.document)
      ? ['exact_cpf']
      : []),
  ];
  const strong = people.filter((c) => matched(c).length);
  result.candidateRead = reasons.size
    ? { status: 'query_failed' }
    : strong.length > 1
      ? { status: 'ambiguous' }
      : strong.length === 1
        ? { status: 'verified', selectedPersonId: strong[0]!.ref.id, matchedBy: matched(strong[0]!) }
        : people.length
          ? { status: 'ambiguous' }
          : { status: 'no_candidate' };
  if (strong.length === 1)
    strong[0]!.sourceRefs = uniqueSources([
      ...strong[0]!.sourceRefs,
      { kind: 'contact', id: String(contact.id), revision },
    ]);
  result.duplicateCheck = { status: 'not_checked' };
  return result;
}

/** Recovery is sufficient to look up retained internal state, without relabeling
 * the missing/stale native link as verified. */
export function candidateLookupLinks(candidates: CustomerCandidates): NonNullable<CustomerCandidates['verifiedLinks']> {
  const links = [...(candidates.verifiedLinks ?? [])];
  if (candidates.candidateRead?.status === 'verified' && candidates.coverage.complete) {
    const selected = candidates.candidates.find(
      (c) => c.ref.kind === 'person' && c.ref.id === candidates.candidateRead!.selectedPersonId,
    );
    if (selected && !links.some((l) => sameEntity(l.ref, selected.ref)))
      links.push({ ref: selected.ref, sourceRefs: selected.sourceRefs });
  }
  return links;
}
