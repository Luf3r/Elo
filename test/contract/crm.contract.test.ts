import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { createAgendorCrmClient } from '../../src/agendor/crm/client';
import { isConfiguredSecret } from '../../src/auth';

const bindings = env as unknown as { AGENDOR_CRM_TOKEN?: string; RUN_AGENDOR_CONTRACT_TESTS?: string };
const enabled = bindings.RUN_AGENDOR_CONTRACT_TESTS === '1' && isConfiguredSecret(bindings.AGENDOR_CRM_TOKEN);
const client = createAgendorCrmClient({ AGENDOR_CRM_TOKEN: bindings.AGENDOR_CRM_TOKEN ?? '' });
const pause = () => new Promise(resolve => setTimeout(resolve, 350));
async function read<T>(operation: () => Promise<T>): Promise<T> { await pause(); return operation(); }

describe.skipIf(!enabled).sequential('real read-only Agendor CRM contract (no record content logged)', () => {
  it('reads people with nullable/optional fields and documented pagination', async () => {
    const page = await read(() => client.searchPeople({ perPage: 1 }));
    expect(Array.isArray(page.items)).toBe(true);
    expect(page.pageInfo).toMatchObject({ page: 1, perPage: 1 });
    for (const person of page.items) {
      expect(typeof (person as { id: unknown }).id).toBe('number');
      const record = person as Record<string, unknown>;
      expect(['contact', 'organization', 'role', 'birthday', 'address', 'cpf'].some(key => record[key] == null)).toBe(true);
    }
  });
  it('returns an empty final page for a unique name prefix', async () => {
    const page = await read(() => client.searchPeople({ query: `mcp-no-match-${crypto.randomUUID()}` }));
    expect(page.items).toEqual([]);
    expect(page.pageInfo).toMatchObject({ hasNext: false, nextPage: null });
  });
  it('reads the next page only when the account has multiple records', async context => {
    const first = await read(() => client.searchPeople({ perPage: 1 }));
    if (first.pageInfo.nextPage === null) { context.skip(); return; }
    const next = await read(() => client.searchPeople({ page: first.pageInfo.nextPage!, perPage: 1 }));
    expect(next.pageInfo.page).toBe(first.pageInfo.nextPage);
    expect(next.items.length).toBeLessThanOrEqual(1);
  });
  it('accepts the documented maximum page size', async () => {
    const page = await read(() => client.searchPeople({ perPage: 100 }));
    expect(page.items.length).toBeLessThanOrEqual(100);
  });
  it('reads organization detail when a real read-only fixture is available', async context => {
    const page = await read(() => client.searchOrganizations({ perPage: 1 }));
    if (!page.items.length) { context.skip(); return; }
    const id = (page.items[0] as { id: number }).id;
    expect(await read(() => client.getOrganization(id))).toMatchObject({ id });
    const tasks = await read(() => client.listTasks({ organizationId: id, perPage: 1, updatedDateGt: new Date(Date.now() - 86_400_000).toISOString() }));
    expect(Array.isArray(tasks.items)).toBe(true);
  });
  it('reads deal detail when a real read-only fixture is available', async context => {
    const page = await read(() => client.searchDeals({ perPage: 1 }));
    if (!page.items.length) { context.skip(); return; }
    const id = (page.items[0] as { id: number }).id;
    expect(await read(() => client.getDeal(id))).toMatchObject({ id });
  });
  it('reads tasks through the documented generic route', async () => {
    const page = await read(() => client.listTasks({ perPage: 1, updatedDateGt: new Date(Date.now() - 86_400_000).toISOString() }));
    expect(Array.isArray(page.items)).toBe(true);
  });
  it('safely reports a nonexistent deal fixture', async () => {
    await expect(read(() => client.getDeal(2_147_483_647))).rejects.toMatchObject({ code: 'UPSTREAM_NOT_FOUND' });
  });
});
