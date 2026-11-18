import { describe, expect, it } from 'vitest';
import * as identity from '../../src/domain/identity';
import type { AgentAnalysis } from '../../src/automation/types';
import { catalogFixture } from '../fixtures/automation';
import { buildAnalysis, buildCandidate, buildCandidates, buildFact, buildSourceRef } from '../fixtures/builders';

const source = buildSourceRef();

describe('conservative customer resolution', () => {
  it('uses a verified Chat–CRM link and backend customer identity with evidence', () => {
    const result = identity.resolveCustomer(
      buildAnalysis(),
      buildCandidates([buildCandidate(11)], {
        customerId: 'backend-customer',
        verifiedLinks: [{ ref: { kind: 'organization', id: 11 }, sourceRefs: [source] }],
      }),
      catalogFixture,
    );
    expect(result).toMatchObject({
      kind: 'resolved',
      customerId: 'backend-customer',
      ref: { kind: 'organization', id: 11 },
      reviewReasons: [],
    });
    expect(result.sourceRefs).toContainEqual(source);
  });

  it('matches normalized exact document rather than API order', () => {
    const input = buildAnalysis({ facts: [buildFact({ field: 'cnpj', value: '12.345.678/0001-90' })] });
    for (const items of [
      [buildCandidate(12), buildCandidate(11, { document: '12345678000190' })],
      [buildCandidate(11, { document: '12345678000190' }), buildCandidate(12)],
    ]) {
      expect(
        identity.resolveCustomer(
          input,
          buildCandidates(items, {
            identifierCoverage: [
              {
                entity: 'organization',
                field: 'cnpj',
                value: '12345678000190',
                coverage: { complete: true, pagesRead: 1, missingReasons: [] },
              },
            ],
          }),
          catalogFixture,
        ),
      ).toMatchObject({ kind: 'resolved', ref: { id: 11 } });
    }
  });

  it('rejects prefix email results, homonyms and shared phone matches', () => {
    expect(
      identity.resolveCustomer(
        buildAnalysis({ facts: [buildFact({ field: 'email', value: 'sales@example.test' })] }),
        buildCandidates([buildCandidate(11, { email: 'sales@example.test.br' })]),
        catalogFixture,
      ),
    ).toMatchObject({ kind: 'review' });

    expect(
      identity.resolveCustomer(
        buildAnalysis(),
        buildCandidates([buildCandidate(11), buildCandidate(12)]),
        catalogFixture,
      ),
    ).toMatchObject({ kind: 'review' });

    expect(
      identity.resolveCustomer(
        buildAnalysis({
          facts: [
            buildFact({ field: 'name', value: 'Synthetic Organization' }),
            buildFact({ field: 'phone', value: '+55 65 99999-0000' }),
          ],
        }),
        buildCandidates([
          buildCandidate(11, { phone: '+5565999990000' }),
          buildCandidate(12, { phone: '+5565999990000' }),
        ]),
        catalogFixture,
      ),
    ).toMatchObject({ kind: 'review' });
  });

  it('does not invent country or area codes for partial telephone numbers', () => {
    expect(
      identity.resolveCustomer(
        buildAnalysis({
          facts: [
            buildFact({ field: 'name', value: 'Synthetic Organization' }),
            buildFact({ field: 'phone', value: '99999-0000' }),
          ],
        }),
        buildCandidates([buildCandidate(11, { phone: '+5565999990000' })]),
        catalogFixture,
      ),
    ).toMatchObject({ kind: 'review' });
  });

  it('blocks unresolved or contradictory coverage even when a selection is present', () => {
    expect(
      identity.resolveCustomer(
        buildAnalysis({ facts: [buildFact({ field: 'cnpj', value: '12345678000190' })] }),
        buildCandidates([buildCandidate(11, { document: '12345678000190' })], {
          coverage: { complete: false, pagesRead: 1, missingReasons: ['page_missing'] },
        }),
        catalogFixture,
      ),
    ).toMatchObject({ kind: 'review', reviewReasons: expect.arrayContaining(['CANDIDATE_COVERAGE_INCOMPLETE']) });

    expect(
      identity.resolveCustomer(
        buildAnalysis({ facts: [buildFact({ field: 'cnpj', value: '12345678000190' })] }),
        buildCandidates([buildCandidate(11, { document: '99999999000100' })]),
        catalogFixture,
      ).kind,
    ).toBe('review');
  });

  it('never uses an agent-selected ID outside the snapshot or infers a represented company from telephone', () => {
    expect(identity.resolveCustomer(buildAnalysis(), buildCandidates([]), catalogFixture).kind).toBe('review');

    const input: AgentAnalysis = buildAnalysis({
      customerSelection: { kind: 'organization', id: 11 },
      facts: [buildFact({ entity: 'person', field: 'organization', value: 11 })],
    });
    expect(
      identity.resolveCustomer(
        input,
        buildCandidates([
          buildCandidate(11),
          buildCandidate(12, { ref: { kind: 'person', id: 12 }, organizationIds: [99] }),
        ]),
        catalogFixture,
      ).kind,
    ).toBe('review');
  });

  it('creates only a minimal evidence-backed identity after complete absence and reviews duplicate names', () => {
    const input = buildAnalysis({
      facts: [
        buildFact({ field: 'name', value: 'Synthetic New' }),
        buildFact({ field: 'email', value: 'new@example.test' }),
      ],
      customerSelection: {
        kind: 'new',
        entity: 'organization',
        record: { name: 'Synthetic New', contact: { email: 'new@example.test' }, description: 'unverified extra' },
      },
    });
    expect(identity.resolveCustomer(input, buildCandidates([]), catalogFixture)).toMatchObject({
      kind: 'create',
      proposal: { record: { name: 'Synthetic New', contact: { email: 'new@example.test' } } },
    });

    const result = identity.resolveCustomer(
      input,
      buildCandidates([buildCandidate(11, { name: 'Synthetic New' })]),
      catalogFixture,
    );
    expect(result.kind).toBe('review');
  });

  it('uses the canonical direct read instead of unnecessary candidate pages', async () => {
    const pages: number[] = [];
    const result = await identity.readCustomerCandidates(
      {
        async searchPeople(input) {
          pages.push(input.page!);
          return {
            items:
              input.page === 1
                ? [{ id: 12, name: 'Other', contact: { email: 'person@example.test.br' } }]
                : [{ id: 13, name: 'Person', contact: { email: 'person@example.test' }, organization: 11 }],
            pageInfo: {
              page: input.page!,
              perPage: 100,
              hasNext: input.page === 1,
              nextPage: input.page === 1 ? 2 : null,
            },
          };
        },
        async searchOrganizations() {
          return { items: [], pageInfo: { page: 1, perPage: 100, hasNext: false, nextPage: null } };
        },
        async getPerson() {
          return { id: 13, name: 'Person', contact: { email: 'person@example.test' }, organization: 11 };
        },
      },
      { id: 42, email: 'person@example.test', crmPersonId: 13 },
      'contact-r1',
    );
    expect(pages).toEqual([]);
    expect(result.coverage.complete).toBe(true);
    expect(result.candidates.map((c) => c.ref.id)).toContain(13);
    expect(result.verifiedLinks?.[0]).toMatchObject({ ref: { kind: 'person', id: 13 } });
  });

  it('fails candidate coverage closed when pagination loops or linked identity is missing', async () => {
    const result = await identity.readCustomerCandidates(
      {
        async searchPeople() {
          return { items: [], pageInfo: { page: 1, perPage: 100, hasNext: true, nextPage: 1 } };
        },
        async searchOrganizations() {
          return { items: [], pageInfo: { page: 1, perPage: 100, hasNext: false, nextPage: null } };
        },
        async getPerson() {
          return { id: 999 };
        },
      },
      { id: 42, name: 'Person', crmPersonId: 13 },
      'contact-r1',
    );
    expect(result.coverage.complete).toBe(false);
    expect(result.verifiedLinks).toEqual([]);
  });

  it('discovers an existing organization by confirmed CNPJ even when contact searches find nothing', async () => {
    const input = buildAnalysis({
      facts: [
        buildFact({ field: 'name', value: 'New Display Name' }),
        buildFact({ field: 'cnpj', value: '12.345.678/0001-90' }),
      ],
      customerSelection: {
        kind: 'new',
        entity: 'organization',
        record: { name: 'New Display Name', cnpj: '12.345.678/0001-90' },
      },
    });
    const queries: { cnpj?: string; page?: number }[] = [];
    const result = await identity.readCustomerCandidates(
      {
        async searchPeople() {
          return { items: [], pageInfo: { page: 1, perPage: 100, hasNext: false, nextPage: null } };
        },
        async searchOrganizations(query) {
          queries.push(query);
          const byDocument = query.cnpj === '12345678000190';
          return {
            items: byDocument && query.page === 2 ? [{ id: 77, name: 'CRM Legal Name', cnpj: '12345678000190' }] : [],
            pageInfo: {
              page: query.page!,
              perPage: 100,
              hasNext: byDocument && query.page === 1,
              nextPage: byDocument && query.page === 1 ? 2 : null,
            },
          };
        },
        async getPerson() {
          throw Error('unused');
        },
      },
      { id: 42, name: 'Different Chat Name', email: 'different@example.test' },
      'contact-r1',
      input.facts,
    );
    expect(queries.filter((q) => q.cnpj).map((q) => ({ cnpj: q.cnpj, page: q.page }))).toEqual([
      { cnpj: '12345678000190', page: 1 },
      { cnpj: '12345678000190', page: 2 },
    ]);
    expect(result.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: { kind: 'organization', id: 77 }, document: '12345678000190' }),
      ]),
    );
    expect(result.coverage).toMatchObject({ complete: true, pagesRead: 6 });
    expect(result.identifierCoverage).toEqual([
      {
        entity: 'organization',
        field: 'cnpj',
        value: '12345678000190',
        coverage: { complete: true, pagesRead: 2, missingReasons: [] },
      },
    ]);
    expect(identity.resolveCustomer(input, result, catalogFixture).kind).toBe('review');
    expect(
      identity.resolveCustomer(
        { ...input, customerSelection: { kind: 'organization', id: 77 } },
        result,
        catalogFixture,
      ),
    ).toMatchObject({ kind: 'resolved', ref: { kind: 'organization', id: 77 } });
  });

  it('requires coverage of the confirmed CNPJ before accepting a new organization', () => {
    const input = buildAnalysis({
      facts: [
        buildFact({ field: 'name', value: 'Synthetic New' }),
        buildFact({ field: 'cnpj', value: '12345678000190' }),
      ],
      customerSelection: { kind: 'new', entity: 'organization', record: { name: 'Synthetic New' } },
    });
    expect(identity.resolveCustomer(input, buildCandidates([]), catalogFixture)).toMatchObject({
      kind: 'review',
      reviewReasons: ['IDENTIFIER_COVERAGE_INCOMPLETE'],
    });
    for (const lookup of [
      { value: '99999999000100', coverage: { complete: true, pagesRead: 1, missingReasons: [] } },
      { value: '12345678000190', coverage: { complete: false, pagesRead: 1, missingReasons: ['page_missing'] } },
    ])
      expect(
        identity.resolveCustomer(
          input,
          buildCandidates([], { identifierCoverage: [{ entity: 'organization', field: 'cnpj', ...lookup }] }),
          catalogFixture,
        ).kind,
      ).toBe('review');
    expect(
      identity.resolveCustomer(
        input,
        buildCandidates([], {
          identifierCoverage: [
            {
              entity: 'organization',
              field: 'cnpj',
              value: '12345678000190',
              coverage: { complete: true, pagesRead: 1, missingReasons: [] },
            },
          ],
        }),
        catalogFixture,
      ).kind,
    ).toBe('create');
  });

  it('blocks a creation when the confirmed CNPJ lookup fails despite complete contact searches', async () => {
    const input = buildAnalysis({
      facts: [
        buildFact({ field: 'name', value: 'Synthetic New' }),
        buildFact({ field: 'cnpj', value: '12345678000190' }),
      ],
      customerSelection: { kind: 'new', entity: 'organization', record: { name: 'Synthetic New' } },
    });
    const result = await identity.readCustomerCandidates(
      {
        async searchPeople() {
          return { items: [], pageInfo: { page: 1, perPage: 100, hasNext: false, nextPage: null } };
        },
        async searchOrganizations(query) {
          if (query.cnpj) throw Error('unavailable');
          return { items: [], pageInfo: { page: query.page!, perPage: 100, hasNext: false, nextPage: null } };
        },
        async getPerson() {
          throw Error('unused');
        },
      },
      { id: 42, name: 'Synthetic New' },
      'contact-r1',
      input.facts,
    );
    expect(result.coverage.complete).toBe(false);
    expect(result.identifierCoverage).toEqual([
      {
        entity: 'organization',
        field: 'cnpj',
        value: '12345678000190',
        coverage: { complete: false, pagesRead: 0, missingReasons: ['candidate_query_failed'] },
      },
    ]);
    expect(identity.resolveCustomer(input, result, catalogFixture).kind).toBe('review');
  });

  it('never declares CNPJ absence from a first page when a later page is unavailable', async () => {
    const input = buildAnalysis({
      facts: [
        buildFact({ field: 'name', value: 'Synthetic New' }),
        buildFact({ field: 'cnpj', value: '12345678000190' }),
      ],
      customerSelection: { kind: 'new', entity: 'organization', record: { name: 'Synthetic New' } },
    });
    const result = await identity.readCustomerCandidates(
      {
        async searchPeople() {
          throw Error('unused');
        },
        async searchOrganizations(query) {
          if (query.page === 2) throw Error('unavailable');
          return { items: [], pageInfo: { page: 1, perPage: 100, hasNext: true, nextPage: 2 } };
        },
        async getPerson() {
          throw Error('unused');
        },
      },
      { id: 42 },
      'contact-r1',
      input.facts,
    );
    expect(result.coverage).toMatchObject({ complete: false, pagesRead: 1 });
    expect(result.identifierCoverage?.[0]?.coverage).toMatchObject({
      complete: false,
      pagesRead: 1,
      missingReasons: ['candidate_query_failed'],
    });
    expect(identity.resolveCustomer(input, result, catalogFixture).kind).toBe('review');
  });
});
