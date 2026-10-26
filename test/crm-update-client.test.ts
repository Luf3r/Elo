import { allowBudget } from './helpers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgendorCrmClient } from '../src/agendor/crm/client';

afterEach(() => vi.unstubAllGlobals());

describe('bounded CRM update client', () => {
  it('updates only allowlisted deal fields using the fixed deal route', async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe('PUT');
      expect(new URL(request.url).origin).toBe('https://api.agendor.com.br');
      expect(new URL(request.url).pathname).toBe('/v3/deals/42');
      expect(await request.json()).toEqual({ title: 'Renewal', value: 1200 });
      return Response.json({ data: { id: 42, title: 'Renewal', value: 1200, description: 'private record data' } });
    });
    vi.stubGlobal('fetch', fetch);
    const client = createAgendorCrmClient({ AGENDOR_CRM_TOKEN: 'test-token' }, { budgetGate: allowBudget });
    await expect(client.updateDeal(42, { title: 'Renewal', value: 1200 })).resolves.toEqual({ id: 42, updatedFields: ['title', 'value'] });
  });

  it('rejects arbitrary deal properties before making a request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const client = createAgendorCrmClient({ AGENDOR_CRM_TOKEN: 'test-token' }, { budgetGate: allowBudget });
    await expect(client.updateDeal(42, { title: 'Renewal', ownerUser: 1 } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects IDs outside the documented 32-bit range before making a request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const client = createAgendorCrmClient({ AGENDOR_CRM_TOKEN: 'test-token' }, { budgetGate: allowBudget });
    expect(() => client.updateDeal(2_147_483_648, { title: 'Renewal' })).toThrow('Invalid tool arguments.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('changes only the documented stage sequence route and checks required fields', async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe('PUT');
      expect(new URL(request.url).pathname).toBe('/v3/deals/42/stage');
      expect(await request.json()).toEqual({ dealStage: 3, checkRequiredFields: true });
      return Response.json({ data: { id: 42, dealStage: 3 } });
    });
    vi.stubGlobal('fetch', fetch);
    const client = createAgendorCrmClient({ AGENDOR_CRM_TOKEN: 'test-token' }, { budgetGate: allowBudget });
    await expect(client.updateDealStage(42, { dealStage: 3 })).resolves.toEqual({ id: 42, updatedFields: ['dealStage'] });
  });

  it('passes a validated funnel ID when moving to a non-default funnel', async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(await request.json()).toEqual({ dealStage: 3, funnel: 9, checkRequiredFields: true });
      return Response.json({ data: { id: 42, dealStage: 3 } });
    });
    vi.stubGlobal('fetch', fetch);
    const client = createAgendorCrmClient({ AGENDOR_CRM_TOKEN: 'test-token' }, { budgetGate: allowBudget });
    await expect(client.updateDealStage(42, { dealStage: 3, funnel: 9 })).resolves.toEqual({ id: 42, updatedFields: ['dealStage', 'funnel'] });
  });

  it('updates people and organizations through their fixed routes', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
      paths.push(new URL(request.url).pathname);
      return Response.json({ data: { id: Number(new URL(request.url).pathname.split('/').at(-1)), name: 'Updated' } });
    }));
    const client = createAgendorCrmClient({ AGENDOR_CRM_TOKEN: 'test-token' }, { budgetGate: allowBudget });
    await expect(client.updatePerson(7, { role: 'Buyer' })).resolves.toMatchObject({ id: 7 });
    await expect(client.updateOrganization(8, { website: 'https://example.com' })).resolves.toMatchObject({ id: 8 });
    expect(paths).toEqual(['/v3/people/7', '/v3/organizations/8']);
  });
});
