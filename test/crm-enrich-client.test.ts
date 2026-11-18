import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCrmMutationClient } from '../src/agendor/crm/mutations';
import { catalogFixture } from './fixtures/automation';

afterEach(() => vi.unstubAllGlobals());
function setup(
  response: (request: Request) => Promise<Response> = () =>
    Promise.resolve(
      Response.json({
        data: {
          id: 42,
          name: 'Synthetic',
          description: 'Saved',
          contact: { email: 'synthetic@example.test', work: 'unknown old value' },
          allowedUsers: [999],
        },
      }),
    ),
) {
  const upstreamFetch = vi.fn(response);
  vi.stubGlobal('fetch', upstreamFetch);
  return {
    upstreamFetch,
    client: createCrmMutationClient({
      env: { AGENDOR_CRM_TOKEN: 'unit-secret' },
      catalog: catalogFixture,
      budgetGate: async () => {},
    }),
  };
}
describe('bounded CRM enrichment', () => {
  it.each([
    ['organization', '/organizations/42'],
    ['person', '/people/42'],
    ['deal', '/deals/42'],
  ] as const)('sends only partial %s fields on its fixed PUT route', async (kind, path) => {
    const { client, upstreamFetch } = setup();
    const outcome =
      kind === 'organization'
        ? await client.enrichOrganization(42, { description: 'Saved' })
        : kind === 'person'
          ? await client.enrichPerson(42, { description: 'Saved' })
          : await client.enrichDeal(42, { description: 'Saved' });
    expect(outcome).toEqual({ state: 'confirmed', ref: { kind, id: 42 }, returnedFields: { description: 'Saved' } });
    const request = upstreamFetch.mock.calls[0]![0] as unknown as Request;
    expect(request.url).toBe(`https://api.agendor.com.br/v3${path}`);
    expect(request.method).toBe('PUT');
    expect(await request.json()).toEqual({ description: 'Saved' });
  });
  it('projects only submitted nested fields rather than leaking unrelated contact data', async () => {
    const { client } = setup();
    expect(await client.enrichPerson(42, { contact: { email: 'synthetic@example.test' } })).toEqual({
      state: 'confirmed',
      ref: { kind: 'person', id: 42 },
      returnedFields: { contact: { email: 'synthetic@example.test' } },
    });
  });
  it.each([420, 2_147_483_647])(
    'sends organization address street_number as int32 %i on enrichment',
    async (street_number) => {
      const { client, upstreamFetch } = setup();
      expect(await client.enrichOrganization(42, { address: { street_number } })).toMatchObject({ state: 'confirmed' });
      const request = upstreamFetch.mock.calls[0]![0];
      expect(request.url).toBe('https://api.agendor.com.br/v3/organizations/42');
      expect(request.method).toBe('PUT');
      expect(await request.json()).toEqual({ address: { street_number } });
    },
  );
  it.each(['420', 's/n', 1.5, 2_147_483_648, -2_147_483_649, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects non-int32 organization street_number %j before enrichment',
    async (street_number) => {
      const { client, upstreamFetch } = setup();
      await expect(client.enrichOrganization(42, { address: { street_number } } as never)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      expect(upstreamFetch).not.toHaveBeenCalled();
    },
  );
  it.each([0, -1, 1.1, 2_147_483_648, '42'])('rejects an invalid update ID %j before transport', async (id) => {
    const { client, upstreamFetch } = setup();
    await expect(client.enrichPerson(id as number, { name: 'Synthetic' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
  it.each([{}, { allowedUsers: [1] }, { contact: { phone: '123' } }, { description: 'x'.repeat(701) }, { ranking: 6 }])(
    'rejects an empty or unsafe person patch %j',
    async (patch) => {
      const { client, upstreamFetch } = setup();
      await expect(client.enrichPerson(42, patch as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(upstreamFetch).not.toHaveBeenCalled();
    },
  );
  it.each([{ customFields: [{ id: 'cf-text', value: 'Known' }] }, { customFields: [] }])(
    'blocks unverified collection replacement and leaves a scalar patch available %j',
    async (patch) => {
      const { client, upstreamFetch } = setup();
      expect(await client.enrichPerson(42, { ...patch, description: 'Saved' })).toEqual({
        state: 'rejected',
        code: 'COLLECTION_WRITE_UNVERIFIED',
      });
      expect(upstreamFetch).not.toHaveBeenCalled();
      expect(await client.enrichPerson(42, { description: 'Saved' })).toMatchObject({ state: 'confirmed' });
    },
  );
  it('updates task scalars using the task_entity envelope and preserves assigned users', async () => {
    const { client, upstreamFetch } = setup(() =>
      Promise.resolve(Response.json({ task_entity: { id: 42, text: 'New text', finished: false } })),
    );
    expect(await client.updateTask(42, { text: 'New text' })).toEqual({
      state: 'confirmed',
      ref: { kind: 'task', id: 42 },
      returnedFields: { text: 'New text' },
    });
    const request = upstreamFetch.mock.calls[0]![0] as unknown as Request;
    expect(request.url).toBe('https://api.agendor.com.br/v3/tasks/42');
    expect(await request.json()).toEqual({ text: 'New text' });
    expect(await client.updateTask(42, { assigned_users: [1] })).toEqual({
      state: 'rejected',
      code: 'COLLECTION_WRITE_UNVERIFIED',
    });
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });
  it('reports only fields actually returned and never manufactures absent requested fields', async () => {
    const { client } = setup(() => Promise.resolve(Response.json({ data: { id: 42 } })));
    expect(await client.enrichPerson(42, { description: 'Saved' })).toEqual({
      state: 'confirmed',
      ref: { kind: 'person', id: 42 },
      returnedFields: {},
    });
  });
  it.each([41, null, '42'])('returns uncertain for an update response with wrong ID %j', async (id) => {
    const { client } = setup(() => Promise.resolve(Response.json({ data: { id, description: 'Saved' } })));
    expect(await client.enrichPerson(42, { description: 'Saved' })).toEqual({
      state: 'uncertain',
      reason: 'UPSTREAM_INVALID_RESPONSE',
    });
  });
  it('keeps uncertain PUT outcomes uncertain without retrying', async () => {
    const { client, upstreamFetch } = setup(() => Promise.resolve(new Response('secret', { status: 500 })));
    expect(await client.enrichOrganization(42, { description: 'Saved' })).toEqual({
      state: 'uncertain',
      reason: 'UPSTREAM_UNAVAILABLE',
    });
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });
});
