import { describe, it, expect } from 'vitest';
import { normalizePage } from '../src/agendor/crm/pagination';

describe('pagination', () => {
  it('normalizes data and nullable optional fields', () => {
    expect(
      normalizePage(
        {
          data: [{ id: 1, contact: null }],
          links: { next: 'https://api.agendor.com.br/v3/people?page=2&per_page=100' },
        },
        1,
        100,
      ),
    ).toEqual({
      items: [{ id: 1, contact: null }],
      pageInfo: { page: 1, perPage: 100, hasNext: true, nextPage: 2 },
    });
  });
  it.each([
    { data: [] },
    { items: [] },
    { data: [], links: {} },
    { data: [], links: null },
    { data: [], links: { next: null } },
  ])('handles empty/final/missing links: %j', (payload) => {
    expect(normalizePage(payload, 3, 20)).toEqual({
      items: [],
      pageInfo: { page: 3, perPage: 20, hasNext: false, nextPage: null },
    });
  });
  it.each([
    'junk',
    'https://api.agendor.com.br/v3/people?cursor=foo',
    'https://api.agendor.com.br/v3/people?page=-1',
    'https://api.agendor.com.br/v3/people?page=2.5',
    'https://attacker.test/?page=2',
    'https://api.agendor.com.br/v3/people?page=1',
    'https://api.agendor.com.br/v3/people?page=9007199254740993',
  ])('does not invent nextPage from %s', (next) => {
    const page = normalizePage({ data: [], links: { next } }, 1, 20);
    expect(page.pageInfo).toMatchObject({ hasNext: true, nextPage: null });
    expect(JSON.stringify(page)).not.toContain(next);
  });
  it.each([null, {}, { data: null }, { data: 'wrong' }, { data: [null] }, { data: [], links: { next: 42 } }])(
    'rejects malformed upstream payloads %j',
    (payload) => {
      expect(() => normalizePage(payload, 1, 20)).toThrow(
        expect.objectContaining({ code: 'UPSTREAM_INVALID_RESPONSE' }),
      );
    },
  );
});
