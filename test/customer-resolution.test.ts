import { describe, expect, it } from 'vitest';
import * as identity from '../src/automation/identity';
import type { AgentAnalysis, CustomerCandidate, CustomerCandidates } from '../src/automation/types';
import { catalogFixture, validAnalysisInput } from './fixtures/automation';
import { env, runInDurableObject, evictDurableObject } from 'cloudflare:test';
import type { Env } from '../src/env';
import type { PlanBasis } from '../src/automation/types';

const source = validAnalysisInput.analysis.facts[0]!.sources[0]!;
const candidate = (id: number, patch: Partial<CustomerCandidate> = {}): CustomerCandidate => ({ ref: { kind: 'organization', id }, name: 'Synthetic Organization', organizationIds: [], sourceRefs: [{ kind: 'crm', id: `organization:${id}`, revision: 'r1' }], ...patch });
const candidates = (items: CustomerCandidate[], patch: Partial<CustomerCandidates> = {}): CustomerCandidates => ({ candidates: items, coverage: { complete: true, missingReasons: [], pagesRead: 2 }, ...patch });
const analysis = (facts: AgentAnalysis['facts'] = validAnalysisInput.analysis.facts): AgentAnalysis => ({ ...validAnalysisInput.analysis, facts });
const fact = (field: string, value: string): AgentAnalysis['facts'][number] => ({ entity: 'organization', field, value, certainty: 'confirmed', sources: [source] });

describe('conservative customer resolution', () => {
  it('uses a verified Chat–CRM link and backend customer identity with evidence', () => {
    const result = identity.resolveCustomer(analysis(), candidates([candidate(11)], { customerId: 'backend-customer', verifiedLinks: [{ ref: { kind: 'organization', id: 11 }, sourceRefs: [source] }] }), catalogFixture);
    expect(result).toMatchObject({ kind: 'resolved', customerId: 'backend-customer', ref: { kind: 'organization', id: 11 }, reviewReasons: [] });
    expect(result.sourceRefs).toContainEqual(source);
  });
  it('matches normalized exact document rather than API order', () => {
    const input = analysis([fact('cnpj', '12.345.678/0001-90')]);
    for (const items of [[candidate(12), candidate(11, { document: '12345678000190' })], [candidate(11, { document: '12345678000190' }), candidate(12)]]) {
      expect(identity.resolveCustomer(input, candidates(items, { identifierCoverage: [{ entity: 'organization', field: 'cnpj', value: '12345678000190', coverage: { complete: true, pagesRead: 1, missingReasons: [] } }] }), catalogFixture)).toMatchObject({ kind: 'resolved', ref: { id: 11 } });
    }
  });
  it('rejects prefix email results, homonyms and shared phone matches', () => {
    expect(identity.resolveCustomer(analysis([fact('email', 'sales@example.test')]), candidates([candidate(11, { email: 'sales@example.test.br' })]), catalogFixture)).toMatchObject({ kind: 'review' });
    expect(identity.resolveCustomer(analysis(), candidates([candidate(11), candidate(12)]), catalogFixture)).toMatchObject({ kind: 'review' });
    expect(identity.resolveCustomer(analysis([fact('name', 'Synthetic Organization'), fact('phone', '+55 65 99999-0000')]), candidates([candidate(11, { phone: '+5565999990000' }), candidate(12, { phone: '+5565999990000' })]), catalogFixture)).toMatchObject({ kind: 'review' });
  });
  it('does not invent country or area codes for partial telephone numbers', () => {
    expect(identity.resolveCustomer(analysis([fact('name', 'Synthetic Organization'), fact('phone', '99999-0000')]), candidates([candidate(11, { phone: '+5565999990000' })]), catalogFixture)).toMatchObject({ kind: 'review' });
  });
  it('blocks unresolved or contradictory coverage even when a selection is present', () => {
    expect(identity.resolveCustomer(analysis([fact('cnpj', '12345678000190')]), candidates([candidate(11, { document: '12345678000190' })], { coverage: { complete: false, pagesRead: 1, missingReasons: ['page_missing'] } }), catalogFixture)).toMatchObject({ kind: 'review', reviewReasons: expect.arrayContaining(['CANDIDATE_COVERAGE_INCOMPLETE']) });
    expect(identity.resolveCustomer(analysis([fact('cnpj', '12345678000190')]), candidates([candidate(11, { document: '99999999000100' })]), catalogFixture).kind).toBe('review');
  });
  it('never uses an agent-selected ID outside the snapshot or infers a represented company from telephone', () => {
    expect(identity.resolveCustomer(analysis(), candidates([]), catalogFixture).kind).toBe('review');
    const input = { ...analysis([{ entity: 'person' as const, field: 'organization', value: 11, sources: [source], certainty: 'confirmed' as const }]), customerSelection: { kind: 'organization' as const, id: 11 } };
    expect(identity.resolveCustomer(input, candidates([candidate(11), candidate(12, { ref: { kind: 'person', id: 12 }, organizationIds: [99] })]), catalogFixture).kind).toBe('review');
  });
  it('creates only a minimal evidence-backed identity after complete absence and reviews duplicate names', () => {
    const input: AgentAnalysis = { ...analysis([fact('name', 'Synthetic New'), fact('email', 'new@example.test')]), customerSelection: { kind: 'new', entity: 'organization', record: { name: 'Synthetic New', contact: { email: 'new@example.test' }, description: 'unverified extra' } } };
    expect(identity.resolveCustomer(input, candidates([]), catalogFixture)).toMatchObject({ kind: 'create', proposal: { record: { name: 'Synthetic New', contact: { email: 'new@example.test' } } } });
    const result = identity.resolveCustomer(input, candidates([candidate(11, { name: 'Synthetic New' })]), catalogFixture);
    expect(result.kind).toBe('review');
  });
  it('uses the canonical direct read instead of unnecessary candidate pages', async () => {
    const pages: number[] = [];
    const result = await identity.readCustomerCandidates({
      async searchPeople(input) { pages.push(input.page!); return { items: input.page === 1 ? [{ id: 12, name: 'Other', contact: { email: 'person@example.test.br' } }] : [{ id: 13, name: 'Person', contact: { email: 'person@example.test' }, organization: 11 }], pageInfo: { page: input.page!, perPage: 100, hasNext: input.page === 1, nextPage: input.page === 1 ? 2 : null } }; },
      async searchOrganizations() { return { items: [], pageInfo: { page: 1, perPage: 100, hasNext: false, nextPage: null } }; },
      async getPerson() { return { id: 13, name: 'Person', contact: { email: 'person@example.test' }, organization: 11 }; },
    }, { id: 42, email: 'person@example.test', crmPersonId: 13 }, 'contact-r1');
    expect(pages).toEqual([]);
    expect(result.coverage.complete).toBe(true);
    expect(result.candidates.map(c => c.ref.id)).toContain(13);
    expect(result.verifiedLinks?.[0]).toMatchObject({ ref: { kind: 'person', id: 13 } });
  });
  it('fails candidate coverage closed when pagination loops or linked identity is missing', async () => {
    const result = await identity.readCustomerCandidates({
      async searchPeople() { return { items: [], pageInfo: { page: 1, perPage: 100, hasNext: true, nextPage: 1 } }; },
      async searchOrganizations() { return { items: [], pageInfo: { page: 1, perPage: 100, hasNext: false, nextPage: null } }; },
      async getPerson() { return { id: 999 }; },
    }, { id: 42, name: 'Person', crmPersonId: 13 }, 'contact-r1');
    expect(result.coverage.complete).toBe(false);
    expect(result.verifiedLinks).toEqual([]);
  });
  it('discovers an existing organization by confirmed CNPJ even when contact searches find nothing', async () => {
    const input: AgentAnalysis = { ...analysis([fact('name', 'New Display Name'), fact('cnpj', '12.345.678/0001-90')]), customerSelection: { kind: 'new', entity: 'organization', record: { name: 'New Display Name', cnpj: '12.345.678/0001-90' } } };
    const queries: { cnpj?: string; page?: number }[] = [];
    const result = await identity.readCustomerCandidates({
      async searchPeople() { return { items: [], pageInfo: { page: 1, perPage: 100, hasNext: false, nextPage: null } }; },
      async searchOrganizations(query) {
        queries.push(query);
        const byDocument = query.cnpj === '12345678000190';
        return { items: byDocument && query.page === 2 ? [{ id: 77, name: 'CRM Legal Name', cnpj: '12345678000190' }] : [], pageInfo: { page: query.page!, perPage: 100, hasNext: byDocument && query.page === 1, nextPage: byDocument && query.page === 1 ? 2 : null } };
      },
      async getPerson() { throw Error('unused'); },
    }, { id: 42, name: 'Different Chat Name', email: 'different@example.test' }, 'contact-r1', input.facts);
    expect(queries.filter(q => q.cnpj).map(q => ({ cnpj: q.cnpj, page: q.page }))).toEqual([{ cnpj: '12345678000190', page: 1 }, { cnpj: '12345678000190', page: 2 }]);
    expect(result.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ ref: { kind: 'organization', id: 77 }, document: '12345678000190' })]));
    expect(result.coverage).toMatchObject({ complete: true, pagesRead: 6 });
    expect(result.identifierCoverage).toEqual([{ entity: 'organization', field: 'cnpj', value: '12345678000190', coverage: { complete: true, pagesRead: 2, missingReasons: [] } }]);
    expect(identity.resolveCustomer(input, result, catalogFixture).kind).toBe('review');
    expect(identity.resolveCustomer({ ...input, customerSelection: { kind: 'organization', id: 77 } }, result, catalogFixture)).toMatchObject({ kind: 'resolved', ref: { kind: 'organization', id: 77 } });
  });
  it('requires coverage of the confirmed CNPJ before accepting a new organization', () => {
    const input: AgentAnalysis = { ...analysis([fact('name', 'Synthetic New'), fact('cnpj', '12345678000190')]), customerSelection: { kind: 'new', entity: 'organization', record: { name: 'Synthetic New' } } };
    expect(identity.resolveCustomer(input, candidates([]), catalogFixture)).toMatchObject({ kind: 'review', reviewReasons: ['IDENTIFIER_COVERAGE_INCOMPLETE'] });
    for (const lookup of [
      { value: '99999999000100', coverage: { complete: true, pagesRead: 1, missingReasons: [] } },
      { value: '12345678000190', coverage: { complete: false, pagesRead: 1, missingReasons: ['page_missing'] } },
    ]) expect(identity.resolveCustomer(input, candidates([], { identifierCoverage: [{ entity: 'organization', field: 'cnpj', ...lookup }] }), catalogFixture).kind).toBe('review');
    expect(identity.resolveCustomer(input, candidates([], { identifierCoverage: [{ entity: 'organization', field: 'cnpj', value: '12345678000190', coverage: { complete: true, pagesRead: 1, missingReasons: [] } }] }), catalogFixture).kind).toBe('create');
  });
  it('blocks a creation when the confirmed CNPJ lookup fails despite complete contact searches', async () => {
    const input: AgentAnalysis = { ...analysis([fact('name', 'Synthetic New'), fact('cnpj', '12345678000190')]), customerSelection: { kind: 'new', entity: 'organization', record: { name: 'Synthetic New' } } };
    const result = await identity.readCustomerCandidates({
      async searchPeople() { return { items: [], pageInfo: { page: 1, perPage: 100, hasNext: false, nextPage: null } }; },
      async searchOrganizations(query) { if (query.cnpj) throw Error('unavailable'); return { items: [], pageInfo: { page: query.page!, perPage: 100, hasNext: false, nextPage: null } }; },
      async getPerson() { throw Error('unused'); },
    }, { id: 42, name: 'Synthetic New' }, 'contact-r1', input.facts);
    expect(result.coverage.complete).toBe(false);
    expect(result.identifierCoverage).toEqual([{ entity: 'organization', field: 'cnpj', value: '12345678000190', coverage: { complete: false, pagesRead: 0, missingReasons: ['candidate_query_failed'] } }]);
    expect(identity.resolveCustomer(input, result, catalogFixture).kind).toBe('review');
  });
  it('never declares CNPJ absence from a first page when a later page is unavailable', async () => {
    const input: AgentAnalysis = { ...analysis([fact('name', 'Synthetic New'), fact('cnpj', '12345678000190')]), customerSelection: { kind: 'new', entity: 'organization', record: { name: 'Synthetic New' } } };
    const result = await identity.readCustomerCandidates({
      async searchPeople() { throw Error('unused'); },
      async searchOrganizations(query) { if (query.page === 2) throw Error('unavailable'); return { items: [], pageInfo: { page: 1, perPage: 100, hasNext: true, nextPage: 2 } }; },
      async getPerson() { throw Error('unused'); },
    }, { id: 42 }, 'contact-r1', input.facts);
    expect(result.coverage).toMatchObject({ complete: false, pagesRead: 1 });
    expect(result.identifierCoverage?.[0]?.coverage).toMatchObject({ complete: false, pagesRead: 1, missingReasons: ['candidate_query_failed'] });
    expect(identity.resolveCustomer(input, result, catalogFixture).kind).toBe('review');
  });
});

describe('durable resolution reservation', () => {
  const state = () => (env as Env).AUTOMATION_STATE.get((env as Env).AUTOMATION_STATE.newUniqueId());
  async function setup(stub: ReturnType<typeof state>, conversationId = 101, customerId = 'backend-customer') {
    const lease = await stub.reserveWork({ requestId: `resolution-${conversationId}`, target: { kind: 'conversation', conversationId }, mode: 'preview', actor: { userId: 'operator', clientId: 'client', scopes: ['automation:process'] }, payloadDigest: 'resolution-input' });
    const basis: PlanBasis = { lease, customerId, snapshotVersion: 1, contextVersion: 0, catalogVersion: catalogFixture.version };
    await stub.installSnapshot(lease, { workId: lease.workId, snapshotVersion: 1, contextVersion: 0, catalogVersion: catalogFixture.version, readAt: new Date().toISOString(), sources: [source], messages: [], records: [], coverage: { complete: true, pagesRead: 1, missingReasons: [] } });
    return basis;
  }
  const newInput = (): AgentAnalysis => ({ ...analysis([fact('name', 'Synthetic New'), fact('email', 'new@example.test')]), customerSelection: { kind: 'new', entity: 'organization', record: { name: 'Synthetic New' } } });
  it('keeps backend IDs stable on retries and eviction; reserves the same identity across conversations', async () => {
    const stub = state(); const basis = await setup(stub);
    const first = await stub.resolveWork(newInput(), candidates([]), catalogFixture, basis);
    expect(first.customer).toMatchObject({ kind: 'create', customerId: 'backend-customer' });
    expect(first.demands.demands[0]?.kind).toBe('create');
    await evictDurableObject(stub);
    expect(await stub.resolveWork(newInput(), candidates([]), catalogFixture, basis)).toEqual(first);
    const other = await setup(stub, 102, 'other-backend-customer');
    expect((await stub.resolveWork(newInput(), candidates([]), catalogFixture, other)).customer).toMatchObject({ kind: 'review', reviewReasons: ['IDENTITY_RESERVED_FOR_OTHER_CUSTOMER'] });
  });
  it('rejects changed retries, stale basis and evidence absent from the server snapshot', async () => {
    const stub = state(); const basis = await setup(stub);
    await stub.resolveWork(newInput(), candidates([]), catalogFixture, basis);
    const failure = async (operation: (instance: import('../src/automation/state/account').AutomationAccount) => Promise<unknown>) => runInDurableObject(stub, async instance => { try { await operation(instance); return 'accepted'; } catch (e) { return (e as Error).message; } });
    expect(await failure(instance => instance.resolveWork({ ...newInput(), demands: [] }, candidates([]), catalogFixture, basis))).toContain('IDEMPOTENCY_CONFLICT');
    expect(await failure(instance => instance.resolveWork(newInput(), candidates([]), catalogFixture, { ...basis, snapshotVersion: 2 }))).toContain('STATE_VERSION_CONFLICT');
    const other = await setup(stub, 103, 'third-customer');
    const forged = newInput(); forged.facts[0]!.sources = [{ ...source, revision: 'forged' }];
    expect(await failure(instance => instance.resolveWork(forged, candidates([]), catalogFixture, other))).toContain('ANALYSIS_INVALID');
  });
  it('holds pending creation across conversations even for the same backend customer', async () => {
    const stub = state(); const basis = await setup(stub);
    const first = await stub.resolveWork(newInput(), candidates([]), catalogFixture, basis);
    const other = await setup(stub, 105);
    const next = await stub.resolveWork(newInput(), candidates([]), catalogFixture, other);
    expect(first.customer.kind).toBe('create');
    expect(next.customer).toMatchObject({ kind: 'review', reviewReasons: ['IDENTITY_CREATION_PENDING'] });
  });
  it('reserves a name-only creation without treating a name as proof that customers are identical', async () => {
    const stub = state(); const basis = await setup(stub);
    const onlyName: AgentAnalysis = { ...newInput(), facts: [fact('name', 'Synthetic New')] };
    await stub.resolveWork(onlyName, candidates([]), catalogFixture, basis);
    const other = await setup(stub, 106, 'another-customer');
    expect((await stub.resolveWork(onlyName, candidates([]), catalogFixture, other)).customer.kind).toBe('review');
  });
});
