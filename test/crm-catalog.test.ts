import { allowBudget } from './helpers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgendorCrmClient } from '../src/automation/clients';
import * as schemas from '../src/agendor/crm/schemas';
import * as catalog from '../src/agendor/crm/catalog';
import { callTool } from './mcp-helper';

const client = () => createAgendorCrmClient({ AGENDOR_CRM_TOKEN: 'unit-crm-token' }, { budgetGate: allowBudget });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function upstream(body: unknown = { data: [], links: { next: null } }) {
  const requests: Request[] = [];
  vi.stubGlobal('fetch', async (request: Request) => {
    requests.push(request);
    return Response.json(body);
  });
  return requests;
}
const date = '2026-10-01T00:00:00Z';
describe('CRM extended read contracts', () => {
  it('maps people identity, custom fields and date filters without dropping false', async () => {
    const requests = upstream();
    await client().searchPeople({
      phone: '556700000000',
      cpf: '000',
      organizationId: 7,
      withCustomFields: false,
      updatedAtGt: date,
      updatedAtLt: date,
    });
    expect(Object.fromEntries(new URL(requests[0]!.url).searchParams)).toEqual({
      page: '1',
      per_page: '20',
      phone: '556700000000',
      cpf: '000',
      organization: '7',
      withCustomFields: 'false',
      updatedAtGt: date,
      updatedAtLt: date,
    });
  });
  it('maps organization identity filters and exactName to nameExact', async () => {
    const requests = upstream();
    await client().searchOrganizations({
      cnpj: '000',
      phone: '556700000000',
      email: 'a@empresa.test',
      exactName: 'Example',
      withCustomFields: true,
      createdAtGt: date,
    });
    expect(Object.fromEntries(new URL(requests[0]!.url).searchParams)).toEqual({
      page: '1',
      per_page: '20',
      cnpj: '000',
      phone: '556700000000',
      email: 'a@empresa.test',
      nameExact: 'Example',
      withCustomFields: 'true',
      createdAtGt: date,
    });
  });
  it.each(['vendas@', 'financeiro'])('accepts organization email prefix %s through client and MCP', async (email) => {
    const requests = upstream();
    await client().searchOrganizations({ email });
    expect(new URL(requests[0]!.url).searchParams.get('email')).toBe(email);
    const result = await callTool('crm_search_organizations', { email });
    expect(result.data.result?.isError).not.toBe(true);
    expect(new URL(requests[1]!.url).searchParams.get('email')).toBe(email);
  });
  it.each(['', '   ', 'x'.repeat(301)])(
    'rejects empty or excessive organization email prefixes before fetch',
    async (email) => {
      const requests = upstream();
      await expect(client().searchOrganizations({ email })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(requests).toHaveLength(0);
    },
  );
  it('keeps deal stage ID distinct from sequence and uses documented array encoding', async () => {
    const requests = upstream();
    await client().searchDeals({
      titleSearch: 'filter',
      funnelIds: [12, 14],
      stageId: 902,
      stageSequence: 3,
      withCustomFields: true,
      startAtGt: date,
      endAtLt: date,
    });
    expect(Object.fromEntries(new URL(requests[0]!.url).searchParams)).toEqual({
      page: '1',
      per_page: '20',
      titleSearch: 'filter',
      funnels: '12,14',
      dealStage: '902',
      dealStageOrder: '3',
      withCustomFields: 'true',
      startAtGt: date,
      endAtLt: date,
    });
    await expect(client().searchDeals({ query: 'prefix', titleSearch: 'full text' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(requests).toHaveLength(1);
  });
  it('rejects malformed read arguments before upstream access', async () => {
    const requests = upstream();
    await expect(client().getPerson(0)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client().getTask(1.5)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client().searchPeople({ withCustomFields: 'true' } as never)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(client().searchOrganizations({ updatedAtGt: 'yesterday' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(client().searchDeals({ funnelIds: [0] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(requests).toHaveLength(0);
  });
  it('reads person custom fields and documented task_entity detail', async () => {
    const requests = upstream({ data: { id: 7, customFields: { synthetic: 'value' } } });
    expect(await client().getPerson(7, { withCustomFields: true })).toMatchObject({ id: 7 });
    expect(requests[0]!.url).toBe('https://api.agendor.com.br/v3/people/7?withCustomFields=true');
    const taskRequests = upstream({ task_entity: { id: 9, text: 'Synthetic task' } });
    expect(await client().getTask(9)).toEqual({ id: 9, text: 'Synthetic task' });
    expect(taskRequests[0]!.url).toBe('https://api.agendor.com.br/v3/tasks/9');
  });
});
describe('bounded CRM catalog', () => {
  it('rejects route-like sections and missing section requirements before fetching', async () => {
    const requests = upstream();
    expect(() => schemas.parseConfiguration({ section: '../../deals' })).toThrow();
    for (const input of [
      { section: 'customFields' },
      { section: 'cities' },
      { section: 'stages' },
      { section: 'funnels', state: 'MT' },
    ]) {
      await expect(client().getConfiguration(input as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(requests).toHaveLength(0);
  });
  it.each([
    [{ section: 'funnels' }, '/v3/funnels', {}],
    [{ section: 'stages', funnelId: 12 }, '/v3/deal_stages', { funnel: '12' }],
    [{ section: 'users' }, '/v3/users', {}],
    [{ section: 'products', page: 2, perPage: 1 }, '/v3/products', { page: '2', per_page: '1' }],
    [{ section: 'customFields', entityType: 'people' }, '/v3/custom_fields/people', {}],
    [{ section: 'origins' }, '/v3/lead_origins', {}],
    [{ section: 'categories' }, '/v3/categories', {}],
    [{ section: 'sectors' }, '/v3/sectors', {}],
    [{ section: 'cities', state: 'MT' }, '/v3/states/MT/cities', {}],
  ])('uses fixed route for %j', async (input, path, params) => {
    const requests = upstream();
    const result = await client().getConfiguration(input as never);
    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe(path);
    expect(Object.fromEntries(url.searchParams)).toEqual(params);
    expect(result.coverage.status).toBe('partial');
    expect(requests).toHaveLength(1);
  });
  it('rejects malformed catalog records and mismatched funnel scope safely', async () => {
    upstream({ data: [{ id: 902, name: 'Synthetic stage', sequence: 3, funnel: { id: 99 } }] });
    await expect(client().getConfiguration({ section: 'stages', funnelId: 12 })).rejects.toMatchObject({
      code: 'UPSTREAM_INVALID_RESPONSE',
    });
    upstream({ data: [{ id: 'unexpected', name: 'Synthetic product' }] });
    await expect(client().getConfiguration({ section: 'products' })).rejects.toMatchObject({
      code: 'UPSTREAM_INVALID_RESPONSE',
    });
  });
  it('preserves continuation without following upstream URLs', async () => {
    const requests = upstream({
      data: [{ id: 3, name: 'Synthetic' }],
      links: { next: 'https://api.agendor.com.br/v3/products?page=3' },
    });
    const result = await client().getConfiguration({ section: 'products', page: 2, perPage: 1 });
    expect(result.pageInfo).toEqual({ page: 2, perPage: 1, hasNext: true, nextPage: 3 });
    expect(result.coverage).toMatchObject({ status: 'partial', pages: [2] });
    expect(requests).toHaveLength(1);
  });
  it('retains stage IDs, sequence and custom field options independently', async () => {
    upstream({
      data: [{ id: 902, name: 'Synthetic stage', sequence: 3, funnel: { id: 12, name: 'Synthetic funnel' } }],
    });
    const stages = await client().getConfiguration({ section: 'stages', funnelId: 12 });
    upstream({
      data: [{ id: 31, name: 'Synthetic field', type: 'select', options: [{ id: 11, name: 'Synthetic option' }] }],
    });
    const fields = await client().getConfiguration({ section: 'customFields', entityType: 'deals' });
    const snapshot = catalog.createCatalogSnapshot({ accountId: 'synthetic-account', pages: [stages, fields] });
    expect(snapshot.stages.find((s) => s.id === 902)?.sequence).toBe(3);
    expect(snapshot.customFields[0]).toMatchObject({
      entityType: 'deals',
      options: [{ id: 11, name: 'Synthetic option' }],
    });
    expect(snapshot.version).toBeTruthy();
  });
  it('compares normalized email equality after upstream prefix searches', () => {
    const prefixResults = [
      { id: 1, contact: { email: ' A@EMPRESA.TEST ' } },
      { id: 2, contact: { email: 'a@empresa.test.br' } },
      { id: 3, contact: null },
    ];
    expect(catalog.findExactEmail(prefixResults, 'a@empresa.test')).toEqual([prefixResults[0]]);
  });
  it('resolves only a unique exact name with complete coverage', () => {
    const items = [
      { id: 1, name: ' Product ' },
      { id: 2, name: 'Product Plus' },
    ];
    expect(catalog.resolveUniqueCatalogName(items, 'product', { status: 'complete', pages: [1] })).toBe(1);
    expect(catalog.resolveUniqueCatalogName(items, 'product', { status: 'partial', pages: [1] })).toBeUndefined();
    expect(
      catalog.resolveUniqueCatalogName([...items, { id: 3, name: 'PRODUCT' }], 'product', {
        status: 'complete',
        pages: [1],
      }),
    ).toBeUndefined();
  });
  it('isolates cached snapshots by account and expires at fifteen minutes', () => {
    vi.useFakeTimers();
    const cache = new catalog.CatalogCache();
    const snapshot = catalog.createCatalogSnapshot({ accountId: 'synthetic-account', pages: [] });
    cache.set(snapshot);
    expect(cache.get('synthetic-account')?.version).toBe(snapshot.version);
    expect(cache.get('other-account')).toBeUndefined();
    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(cache.get('synthetic-account')).toBeUndefined();
  });
  it.each([
    ['crm_get_person', { id: 7, withCustomFields: true }, { data: { id: 7 } }],
    ['crm_get_task', { id: 7 }, { task_entity: { id: 7 } }],
    ['crm_get_configuration', { section: 'products' }, { data: [] }],
  ])('exposes %s with crm:read and rejects other scopes', async (name, input, body) => {
    const requests = upstream(body);
    const allowed = await callTool(name, input);
    expect(allowed.data.result?.isError).not.toBe(true);
    const denied = await callTool(name, input, undefined, ['chat:read']);
    expect(denied.data.result?.isError).toBe(true);
    expect(requests).toHaveLength(1);
  });
});
