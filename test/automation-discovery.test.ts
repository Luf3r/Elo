import { afterEach, expect, it, vi } from 'vitest';
import { createAutomationService } from '../src/automation/service';
import { budgetMock, testEnv } from './helpers';
import type { AuthContext } from '../src/auth';

const actor = () =>
  ({
    userId: 'operator',
    clientId: 't01',
    scopes: ['automation:process', 'automation:manage', 'chat:read', 'crm:read'],
    expiresAt: Date.now() + 600_000,
  }) as AuthContext;
async function setup(enabled = true) {
  const env = testEnv({ AGENDOR_CHAT_TOKEN: 'synthetic-chat', AGENDOR_CHAT_ACCOUNT_ID: '123' });
  budgetMock(env).mockResolvedValue({ allowed: true, reservationId: 'test' });
  const auth = actor();
  const service = createAutomationService(env, auth);
  await service.updatePolicy({ expectedVersion: 1, patch: { mode: 'preview' } });
  return { env, service, auth };
}
const timestamp = () => Math.floor(Date.now() / 1000);
const response = (payload: unknown[]) => Response.json({ data: { payload } });
afterEach(() => vi.unstubAllGlobals());

it('checks the inbox inventory first and refuses scope expansion', async () => {
  const { service } = await setup(false);
  const fetch = vi.fn(async () => Response.json({ payload: [{ id: 4101 }, { id: 4102 }], links: { next: null } }));
  vi.stubGlobal('fetch', fetch);
  expect(await service.preflight({ target: { kind: 'pending' }, mode: 'preview' })).toMatchObject({
    state: 'ready_for_discovery',
    discovery: { inboxInventoryCheckedBeforeEachCall: true },
  });
  expect(await service.discover({ inboxIds: [4101, 9999] })).toMatchObject({
    state: 'blocked',
    reason: 'INBOX_SCOPE_NOT_AUTHORIZED',
  });
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  [{ payload: [{ id: 4101 }, { id: 4102 }, { id: 9999 }], links: { next: null } }],
  [{ payload: [{ id: 4101 }, { id: 4102 }], links: { next: '/page/2' } }],
  [{ payload: [{ id: 4101 }, { id: 4101 }], links: { next: null } }],
])(
  'stops before conversation listing unless account inbox inventory proves exactly both allowed inboxes',
  async (inventory) => {
    const { service } = await setup();
    const fetch = vi.fn(async () => Response.json(inventory));
    vi.stubGlobal('fetch', fetch);
    await expect(service.discover({})).rejects.toMatchObject({ code: 'UPSTREAM_INVALID_RESPONSE' });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it.each([{}, { inbox_id: 9999 }, { inbox_id: 4101, meta: { inbox: { id: 4102 } } }])(
  'rejects an entire page if any row has unproven inbox %j',
  async (extra) => {
    const { service } = await setup();
    const fetch = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname.endsWith('/inboxes'))
        return Response.json({ payload: [{ id: 4101 }, { id: 4102 }], links: { next: null } });
      return response([
        { id: 101, inbox_id: 4101, timestamp: timestamp(), status: 'pending' },
        {
          id: 102,
          timestamp: timestamp(),
          status: 'open',
          messages: [{ content: 'synthetic foreign content' }],
          ...extra,
        },
      ]);
    });
    vi.stubGlobal('fetch', fetch);
    await expect(service.discover({ inboxIds: [4101] })).rejects.toMatchObject({ code: 'UPSTREAM_INVALID_RESPONSE' });
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);

it('bounds each page, binds continuation to actor, scope and policy, and stops repeating pages', async () => {
  const { env, service, auth } = await setup();
  const fetch = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/inboxes'))
      return Response.json({ payload: [{ id: 4101 }, { id: 4102 }], links: { next: null } });
    expect(url.pathname).toBe('/api/v1/accounts/123/conversations');
    expect(url.searchParams.get('inbox_id')).toBe('4101');
    return response([{ id: 101, inbox_id: 4101, timestamp: timestamp(), status: 'pending' }]);
  });
  vi.stubGlobal('fetch', fetch);
  const first = await service.discover({ inboxIds: [4101] });
  expect(first).toMatchObject({ state: 'continue', page: 1, cursor: expect.any(String) });
  expect(fetch).toHaveBeenCalledTimes(2);
  if (first.state !== 'continue') throw Error('Expected cursor');
  await expect(service.discover({ cursor: first.cursor })).rejects.toMatchObject({ code: 'WORK_STALE' });
  await expect(
    createAutomationService(env, { ...auth, clientId: 'other-client' }).discover({
      cursor: first.cursor,
      inboxIds: [4101],
    }),
  ).rejects.toMatchObject({ code: 'WORK_STALE' });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(await service.discover({ cursor: first.cursor, inboxIds: [4101] })).toMatchObject({
    state: 'end',
    page: 2,
    candidates: [],
    coverage: { reason: 'page_repeated' },
  });
  await service.updatePolicy({ expectedVersion: 2, patch: { mode: 'preview', allowedInboxIds: [4101] } });
  await expect(service.discover({ cursor: first.cursor, inboxIds: [4101] })).rejects.toMatchObject({
    code: 'WORK_STALE',
  });
  expect(fetch).toHaveBeenCalledTimes(4);
});

it('returns the same cursor on a transient failure and resumes at the failed page', async () => {
  const { service } = await setup();
  const calls: string[] = [];
  const fetch = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/inboxes'))
      return Response.json({ payload: [{ id: 4101 }, { id: 4102 }], links: { next: null } });
    const page = url.searchParams.get('page')!;
    calls.push(page);
    if (calls.length === 2) return new Response(null, { status: 429 });
    return response(page === '1' ? [{ id: 101, inbox_id: 4101, timestamp: timestamp(), status: 'open' }] : []);
  });
  vi.stubGlobal('fetch', fetch);
  const first = await service.discover({ inboxIds: [4101] });
  if (first.state !== 'continue') throw Error('Expected cursor');
  const next = { inboxIds: [4101], cursor: first.cursor };
  expect(await service.discover(next)).toMatchObject({
    state: 'deferred',
    cursor: first.cursor,
    retryAt: expect.any(String),
  });
  expect(await service.discover(next)).toMatchObject({ state: 'end', page: 2, candidates: [] });
  expect(calls).toEqual(['1', '2', '2']);
});

it('stops a scan after ten pages per inbox even if the collection never ends', async () => {
  const { service } = await setup();
  const fetch = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/inboxes'))
      return Response.json({ payload: [{ id: 4101 }, { id: 4102 }], links: { next: null } });
    const page = Number(url.searchParams.get('page'));
    return response([{ id: 100 + page, inbox_id: 4101, timestamp: timestamp(), status: 'open' }]);
  });
  vi.stubGlobal('fetch', fetch);
  let cursor: string | undefined;
  for (let n = 1; n <= 10; n++) {
    const page = await service.discover({ inboxIds: [4101], cursor });
    expect(page).toMatchObject({ page: n, state: n < 10 ? 'continue' : 'end' });
    cursor = 'cursor' in page ? page.cursor : undefined;
    if (n === 10) expect(page).toMatchObject({ coverage: { complete: false, reason: 'page_limit' } });
  }
  expect(cursor).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(20);
});

it('accepts the live payload-only List all inboxes shape below the page ceiling', async () => {
  const { service } = await setup();
  const paths: string[] = [];
  const fetch = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    paths.push(url.pathname);
    if (url.pathname.endsWith('/inboxes')) return Response.json({ payload: [{ id: 4102 }, { id: 4101 }] });
    return Response.json({ data: { payload: [] }, links: { next: null } });
  });
  vi.stubGlobal('fetch', fetch);
  const first = await service.discover({ inboxIds: [4101, 4102] });
  expect(first).toMatchObject({ state: 'continue', candidates: [], inboxId: 4101, cursor: expect.any(String) });
  if (first.state !== 'continue') throw Error('Expected cursor to the second authorized inbox');
  expect(await service.discover({ inboxIds: [4101, 4102], cursor: first.cursor })).toMatchObject({
    state: 'end',
    candidates: [],
    inboxId: 4102,
  });
  expect(paths).toEqual([
    '/api/v1/accounts/123/inboxes',
    '/api/v1/accounts/123/conversations',
    '/api/v1/accounts/123/inboxes',
    '/api/v1/accounts/123/conversations',
  ]);
});
