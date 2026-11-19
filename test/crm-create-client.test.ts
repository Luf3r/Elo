import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCrmMutationClient } from '../src/automation/clients';
import { catalogFixture } from './fixtures/automation';

afterEach(() => vi.unstubAllGlobals());
const personFixture = { name: 'Synthetic Person' };
function setup(
  response: (request: Request) => Promise<Response> = () =>
    Promise.resolve(Response.json({ data: { id: 42, name: 'Synthetic Person', secret: 'must not escape' } })),
) {
  const upstreamFetch = vi.fn(response);
  vi.stubGlobal('fetch', upstreamFetch);
  const budgetGate = vi.fn(async () => {});
  const mutationClient = createCrmMutationClient({
    env: { AGENDOR_CRM_TOKEN: 'unit-secret' },
    catalog: catalogFixture,
    budgetGate,
  });
  return { upstreamFetch, mutationClient, budgetGate };
}
describe('bounded CRM creation', () => {
  it('rejeita mudança de visibilidade no cadastro', async () => {
    const { mutationClient, upstreamFetch, budgetGate } = setup();
    await expect(mutationClient.createPerson({ ...personFixture, allowedUsers: [1] } as never)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(budgetGate).not.toHaveBeenCalled();
  });
  it.each([
    { id: 123 },
    { url: 'https://evil.test' },
    { headers: { Authorization: 'Bearer bad' } },
    { author: 1 },
    { allowToAllUsers: true },
    { organization: 2_147_483_648 },
  ])('rejects caller-selected IDs, routing, credentials or protected fields %j', async (extra) => {
    const { mutationClient, upstreamFetch } = setup();
    await expect(mutationClient.createPerson({ ...personFixture, ...extra })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
  it.each([
    ['person', '/people', { name: 'Synthetic Person' }],
    [
      'organization',
      '/organizations',
      { name: 'Synthetic Company', address: { street_name: 'Synthetic Street', city: 1 } },
    ],
  ] as const)(
    'creates a minimal %s on its fixed route and reports only returned submitted fields',
    async (kind, path, record) => {
      const { mutationClient, upstreamFetch, budgetGate } = setup();
      const outcome =
        kind === 'person' ? await mutationClient.createPerson(record) : await mutationClient.createOrganization(record);
      expect(outcome).toEqual({
        state: 'confirmed',
        ref: { kind, id: 42 },
        returnedFields: { name: 'Synthetic Person' },
      });
      const request = upstreamFetch.mock.calls[0]![0];
      expect(request.url).toBe(`https://api.agendor.com.br/v3${path}`);
      expect(request.method).toBe('POST');
      expect(request.headers.get('Authorization')).toBe('Token unit-secret');
      expect(request.headers.get('Content-Type')).toBe('application/json');
      expect(request.redirect).toBe('manual');
      expect(await request.json()).toEqual(record);
      expect(budgetGate).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(outcome)).not.toMatch(/secret|Bearer|unit-secret/);
    },
  );
  it.each(['organization', 'person'] as const)(
    'creates a deal under exactly one %s and checks required fields',
    async (kind) => {
      const { mutationClient, upstreamFetch } = setup(() =>
        Promise.resolve(Response.json({ data: { id: 73, title: 'Synthetic request' } })),
      );
      expect(await mutationClient.createDeal({ kind, id: 11 }, { title: 'Synthetic request' })).toEqual({
        state: 'confirmed',
        ref: { kind: 'deal', id: 73 },
        returnedFields: { title: 'Synthetic request' },
      });
      const request = upstreamFetch.mock.calls[0]![0];
      expect(request.url).toBe(
        `https://api.agendor.com.br/v3/${kind === 'person' ? 'people' : 'organizations'}/11/deals`,
      );
      expect(await request.json()).toEqual({ title: 'Synthetic request', checkRequiredFields: true });
    },
  );
  it.each([420, 2_147_483_647])(
    'sends organization address street_number as int32 %i on creation',
    async (street_number) => {
      const { mutationClient, upstreamFetch } = setup();
      expect(
        await mutationClient.createOrganization({ name: 'Synthetic Company', address: { street_number } }),
      ).toMatchObject({ state: 'confirmed' });
      const request = upstreamFetch.mock.calls[0]![0];
      expect(request.url).toBe('https://api.agendor.com.br/v3/organizations');
      expect(await request.json()).toEqual({ name: 'Synthetic Company', address: { street_number } });
    },
  );
  it.each(['420', 's/n', 1.5, 2_147_483_648, -2_147_483_649, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects non-int32 organization street_number %j before creation',
    async (street_number) => {
      const { mutationClient, upstreamFetch, budgetGate } = setup();
      await expect(
        mutationClient.createOrganization({ name: 'Synthetic Company', address: { street_number } } as never),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(upstreamFetch).not.toHaveBeenCalled();
      expect(budgetGate).not.toHaveBeenCalled();
    },
  );
  it('validates the catalog-bound deal wrapper and record schemas consistently', async () => {
    const { createMutationSchemas } = await import('../src/agendor/crm/mutation-schemas');
    const schemas = createMutationSchemas(catalogFixture);
    expect(
      schemas.createDeal.safeParse({
        parent: { kind: 'person', id: 12 },
        record: { title: 'Synthetic request', ownerUser: 1 },
      }).success,
    ).toBe(true);
    expect(
      schemas.createDeal.safeParse({
        parent: { kind: 'person', id: 12 },
        record: { title: 'Synthetic request', ownerUser: 999 },
      }).success,
    ).toBe(false);
    expect(schemas.createDealRecord.safeParse({ title: 'Synthetic request', ownerUser: 1 }).success).toBe(true);
  });
  it('maps known typed custom fields to the documented write map on creation', async () => {
    const { mutationClient, upstreamFetch } = setup();
    await mutationClient.createPerson({
      ...personFixture,
      customFields: [{ id: 'cf-text', value: 'Synthetic value' }],
    });
    const request = upstreamFetch.mock.calls[0]![0];
    expect(await request.json()).toEqual({ name: 'Synthetic Person', customFields: { 'cf-text': 'Synthetic value' } });
  });
  it.each([
    { id: 'unknown', value: 'x' },
    { id: 'cf-text', value: 8 },
    { id: '__proto__', value: 'x' },
  ])('rejects unknown or wrongly typed custom fields %j', async (field) => {
    const { mutationClient, upstreamFetch } = setup();
    await expect(mutationClient.createPerson({ ...personFixture, customFields: [field] })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
  it('blocks unverified product price/discount semantics without losing a minimal deal', async () => {
    const { mutationClient, upstreamFetch } = setup();
    expect(
      await mutationClient.createDeal(
        { kind: 'person', id: 12 },
        { title: 'Synthetic', products_entities: [{ id: 31, quantity: 2, unitValue: 25, discount: 5 }] },
      ),
    ).toEqual({ state: 'rejected', code: 'COLLECTION_WRITE_UNVERIFIED' });
    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(await mutationClient.createDeal({ kind: 'person', id: 12 }, { title: 'Synthetic' })).toMatchObject({
      state: 'confirmed',
    });
  });
  it.each(['organization', 'person', 'deal'] as const)(
    'creates a task under %s with textual task type and without implying completion',
    async (kind) => {
      const { mutationClient, upstreamFetch } = setup(() =>
        Promise.resolve(Response.json({ data: { id: 81, text: 'Synthetic callback' } })),
      );
      const record = {
        text: 'Synthetic callback',
        type: 'LIGACAO' as const,
        assigned_users: [1],
        due_date: '2026-10-27T14:00:00Z',
      };
      expect(await mutationClient.createTask({ kind, id: 11 }, record)).toMatchObject({
        state: 'confirmed',
        ref: { kind: 'task', id: 81 },
      });
      const request = upstreamFetch.mock.calls[0]![0];
      expect(request.url).toBe(`https://api.agendor.com.br/v3/${kind === 'person' ? 'people' : `${kind}s`}/11/tasks`);
      expect(await request.json()).toEqual(record);
    },
  );
  it.each([{ type: 1 }, { type: 'UNKNOWN' }, { assigned_users: [999] }, { finished_date: '2026-10-26T14:00:00Z' }])(
    'rejects invalid task types, users and completion %j',
    async (extra) => {
      const { mutationClient, upstreamFetch } = setup();
      await expect(
        mutationClient.createTask({ kind: 'deal', id: 1 }, {
          text: 'Synthetic',
          type: 'EMAIL',
          assigned_users: [1],
          due_date: '2026-10-27T14:00:00Z',
          ...extra,
        } as never),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(upstreamFetch).not.toHaveBeenCalled();
    },
  );
  it.each([400, 401, 403, 404, 409, 422, 429])(
    'reports a definitive rejection for HTTP %i without echoing upstream content',
    async (status) => {
      const { mutationClient, upstreamFetch } = setup(() =>
        Promise.resolve(new Response('unit-secret Bearer secret', { status, headers: { 'Retry-After': '12' } })),
      );
      const outcome = await mutationClient.createPerson(personFixture);
      expect(outcome).toMatchObject({ state: 'rejected' });
      if (status === 409) expect(outcome).toMatchObject({ code: 'UPSTREAM_CONFLICT' });
      if (status === 429) expect(outcome).toMatchObject({ code: 'UPSTREAM_RATE_LIMITED', retryAfterSeconds: 12 });
      expect(JSON.stringify(outcome)).not.toMatch(/unit-secret|Bearer/);
      expect(upstreamFetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    ['server failure', () => Promise.resolve(new Response('secret', { status: 503 }))],
    ['invalid JSON', () => Promise.resolve(new Response('secret'))],
    ['network failure', () => Promise.reject(new Error('secret'))],
    ['invalid record ID', () => Promise.resolve(Response.json({ data: { id: 2_147_483_648 } }))],
    [
      'redirect',
      () => Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://evil.test' } })),
    ],
  ] as const)('returns uncertain after %s with no retry', async (_label, response) => {
    const { mutationClient, upstreamFetch } = setup(response);
    expect(await mutationClient.createPerson(personFixture)).toMatchObject({ state: 'uncertain' });
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });
  it('distinguishes a cancellation before dispatch from one after dispatch', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => {
      controller.abort();
      throw Error('bearer-secret');
    });
    const mutationClient = createCrmMutationClient({
      env: { AGENDOR_CRM_TOKEN: 'unit-secret' },
      catalog: catalogFixture,
      budgetGate: async () => {},
      request,
      signal: controller.signal,
    });
    expect(await mutationClient.createPerson(personFixture)).toEqual({
      state: 'uncertain',
      reason: 'UPSTREAM_CANCELLED',
    });
    await expect(mutationClient.createPerson(personFixture)).rejects.toMatchObject({ retryable: false });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('does not send after budget denial and fails closed without the shared budget binding', async () => {
    const upstreamFetch = vi.fn();
    vi.stubGlobal('fetch', upstreamFetch);
    const mutationClient = createCrmMutationClient({
      env: { AGENDOR_CRM_TOKEN: 'unit-secret' },
      catalog: catalogFixture,
    });
    await expect(mutationClient.createPerson(personFixture)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});
