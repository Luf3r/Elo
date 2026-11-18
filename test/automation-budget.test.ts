import { env } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { createAgendorCrmClient } from '../src/automation/clients';
import { executeRead } from '../src/mcp/tools/read';
import { testEnv } from './helpers';
const state = () => (env as Env).AUTOMATION_STATE.get((env as Env).AUTOMATION_STATE.newUniqueId());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('atomically permits four requests per rolling 10 seconds, separated by product', async () => {
  const stub = state();
  const tickets = await Promise.all(Array.from({ length: 5 }, () => stub.takeBudget('crm', 0)));
  expect(tickets.filter((t) => t.allowed)).toHaveLength(4);
  expect(tickets[4]).toEqual({ allowed: false, retryAt: 10_000 });
  expect(await stub.takeBudget('crm', 1_000)).toEqual({ allowed: false, retryAt: 10_000 });
  expect(await stub.takeBudget('chat', 1_000)).toMatchObject({ allowed: true });
  expect(await stub.takeBudget('crm', 10_000)).toMatchObject({ allowed: true });
});
it('uses a rolling window, preserves credit after cancellation and clamps backward clocks', async () => {
  const stub = state();
  for (const now of [0, 2_000, 4_000, 6_000]) await stub.takeBudget('crm', now);
  expect(await stub.takeBudget('crm', 9_999)).toEqual({ allowed: false, retryAt: 10_000 });
  expect(await stub.takeBudget('crm', 10_000)).toMatchObject({ allowed: true });
  expect(await stub.takeBudget('crm', 0)).toEqual({ allowed: false, retryAt: 12_000 });
});
it('counts every internal MCP request against the same budget used by automation', async () => {
  const bindings = testEnv();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ data: [] })),
  );
  const result = await executeRead(bindings, { clientId: 'mcp', scopes: ['crm:read'] }, async (client) => {
    await client.searchPeople({});
    await client.searchOrganizations({});
    return client.searchDeals({});
  });
  expect(result.isError).toBeUndefined();
  const client = createAgendorCrmClient(bindings);
  await client.searchPeople({});
  await expect(client.searchPeople({})).rejects.toMatchObject({ code: 'UPSTREAM_RATE_LIMITED' });
  expect(fetch).toHaveBeenCalledTimes(4);
});
it('fails closed without the shared gate before any upstream request', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ data: [] })),
  );
  const client = createAgendorCrmClient({ AGENDOR_CRM_TOKEN: 'synthetic-token' });
  await expect(client.searchPeople({})).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  expect(fetch).not.toHaveBeenCalled();
});

it('does not refund a reservation when cancellation happens while awaiting the gate', async () => {
  const bindings = testEnv();
  const controller = new AbortController();
  const { createBudgetGate } = await import('../src/automation/state/budget');
  const gate = createBudgetGate(bindings, 'crm');
  const client = createAgendorCrmClient(bindings, {
    signal: controller.signal,
    budgetGate: async () => {
      await gate();
      controller.abort();
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ data: [] })),
  );
  await expect(client.searchPeople({})).rejects.toBeDefined();
  const other = createAgendorCrmClient(bindings);
  for (let i = 0; i < 3; i++) await other.searchPeople({});
  await expect(other.searchPeople({})).rejects.toMatchObject({ code: 'UPSTREAM_RATE_LIMITED' });
  expect(fetch).toHaveBeenCalledTimes(3);
});
it('shares Chat credit across detail, messages, attachment listing and download requests', async () => {
  const { createAgendorChatClient } = await import('../src/automation/clients');
  const bindings = testEnv({ AGENDOR_CHAT_TOKEN: 'synthetic-token', AGENDOR_CHAT_ACCOUNT_ID: '100' });
  const client = createAgendorChatClient(bindings, {
    request: async (request) => {
      if (request.url.endsWith('/attachments'))
        return Response.json({ payload: [{ id: 400, data_url: 'https://chat.agendor.com.br/files/synthetic' }] });
      if (new URL(request.url).pathname.endsWith('/messages')) return Response.json({ payload: [] });
      if (request.url.endsWith('/200')) return Response.json({ id: 200 });
      return new Response('synthetic', { headers: { 'content-type': 'text/plain' } });
    },
  });
  await client.getConversation(200);
  await client.listMessages(200);
  expect(await client.readAttachment({ conversationId: 200, attachmentId: 400 })).toMatchObject({
    status: 'available',
  });
  await expect(client.listMessages(200)).rejects.toMatchObject({ code: 'UPSTREAM_RATE_LIMITED' });
});
it('waits for shared credit before downloading an attachment after metadata consumed the last slot', async () => {
  vi.useFakeTimers();
  const originalSetTimeout = globalThis.setTimeout;
  let retryScheduledResolve!: () => void;
  const retryScheduled = new Promise<void>((resolve) => {
    retryScheduledResolve = resolve;
  });
  let tenSecondTimers = 0;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    handler: Parameters<typeof setTimeout>[0],
    timeout?: number,
    ...args: unknown[]
  ) => {
    if (timeout === 10_000 && ++tenSecondTimers === 2) retryScheduledResolve();
    return originalSetTimeout(handler, timeout, ...args);
  }) as typeof setTimeout);
  const { createAgendorChatClient } = await import('../src/automation/clients');
  const bindings = testEnv({ AGENDOR_CHAT_TOKEN: 'synthetic-token', AGENDOR_CHAT_ACCOUNT_ID: '100' });
  const request = vi.fn(async (request: Request) =>
    request.url.endsWith('/attachments')
      ? Response.json({ payload: [{ id: 400, data_url: 'https://chat.agendor.com.br/files/synthetic' }] })
      : new Response('file', { headers: { 'content-type': 'text/plain' } }),
  );
  const client = createAgendorChatClient(bindings, { request });
  const stub = bindings.AUTOMATION_STATE.getByName('elotenant');
  for (let i = 0; i < 3; i++) await stub.takeBudget('chat', Date.now());
  const download = client.readAttachment({ conversationId: 200, attachmentId: 400 });
  await retryScheduled;
  expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_001);
  expect(await download).toMatchObject({ status: 'available' });
  expect(request).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});
it('routes the production factory to the same server-owned account key', async () => {
  const { accountState } = await import('../src/automation/state/budget');
  const bindings = env as Env;
  expect(accountState(bindings).id.toString()).toBe(bindings.AUTOMATION_STATE.idFromName('elotenant').toString());
});
