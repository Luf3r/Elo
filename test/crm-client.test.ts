import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgendorCrmClient } from '../src/agendor/crm/client';

afterEach(() => vi.unstubAllGlobals());
const client = () => createAgendorCrmClient({ AGENDOR_CRM_TOKEN: 'unit-crm-token' });
function mockFetch(data: unknown = { data: [] }) {
  const fetch = vi.fn(async (_request: Request) => Response.json(data));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
describe('CRM request contract', () => {
  it('encodes people email and pagination with Token auth, timeout and GET only', async () => {
    const fetch = mockFetch();
    await client().searchPeople({ email: 'a+b@example.com', page: 2, perPage: 100 });
    const r = fetch.mock.calls[0]![0] as Request;
    expect(r.url).toBe('https://api.agendor.com.br/v3/people?page=2&per_page=100&email=a%2Bb%40example.com');
    expect(r.method).toBe('GET');
    expect(r.headers.get('Authorization')).toBe('Token unit-crm-token');
    expect(r.headers.get('Accept')).toBe('application/json');
    expect(r.signal).toBeDefined();
    expect(r.redirect).toBe('manual');
  });
  it('maps only documented deal filters', async () => {
    const fetch = mockFetch();
    await client().searchDeals({ query: 'Água & Cia', organizationId: 2, personId: 3, ownerId: 4, status: '1' });
    const u = new URL((fetch.mock.calls[0]![0] as Request).url);
    expect(Object.fromEntries(u.searchParams)).toEqual({ page: '1', per_page: '20', title: 'Água & Cia', organization: '2', person: '3', userOwner: '4', dealStatus: '1' });
  });
  it('maps organization query and omits undefined filters', async () => {
    const fetch = mockFetch();
    await client().searchOrganizations({ query: 'Elo' });
    expect(new URL((fetch.mock.calls[0]![0] as Request).url).searchParams.get('name')).toBe('Elo');
    expect((fetch.mock.calls[0]![0] as Request).url).not.toContain('undefined');
  });
  it.each([['dealId', 'deal'], ['personId', 'person'], ['organizationId', 'organization']])('maps tasks %s to documented entity filter', async (field, type) => {
    const fetch = mockFetch();
    await client().listTasks({ [field]: 12 });
    const u = new URL((fetch.mock.calls[0]![0] as Request).url);
    expect(u.pathname).toBe('/v3/tasks');
    expect(u.searchParams.get('entityType')).toBe(type);
    expect(u.searchParams.get('entityId')).toBe('12');
  });
  it('supports generic task listing without entity filters', async () => {
    const fetch = mockFetch();
    await client().listTasks({});
    expect((fetch.mock.calls[0]![0] as Request).url).toBe('https://api.agendor.com.br/v3/tasks?page=1&per_page=20');
  });
  it('unwraps detail envelopes and tolerates nullable fields', async () => {
    const fetch = mockFetch({ data: { id: 7, contact: null, description: null } });
    expect(await client().getOrganization(7)).toEqual({ id: 7, contact: null, description: null });
    await client().getDeal(7);
    expect((fetch.mock.calls[1]![0] as Request).url).toBe('https://api.agendor.com.br/v3/deals/7');
  });
  it('rejects invalid IDs, ambiguous filters, status and pagination before fetching', async () => {
    const fetch = mockFetch();
    await expect(client().getDeal(-1)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client().listTasks({ dealId: 1, personId: 2 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client().searchDeals({ status: 'open' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client().searchPeople({ perPage: 101 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('safely maps upstream errors through the shared helper', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private', { status: 429 })));
    await expect(client().searchPeople({})).rejects.toMatchObject({ code: 'UPSTREAM_RATE_LIMITED' });
  });
  it('rejects a malformed detail response', async () => {
    mockFetch({ data: null });
    await expect(client().getDeal(1)).rejects.toMatchObject({ code: 'UPSTREAM_INVALID_RESPONSE' });
  });
});
