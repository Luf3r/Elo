import { afterEach, describe, expect, it, vi } from 'vitest';
import { callTool, rpc } from './mcp-helper';
import { testEnv } from './helpers';
import { createAutomationService } from '../src/automation/service';
import { budgetMock } from './helpers';
import { plannerAnalysis } from './fixtures/planner';
import { buildActor, buildAnalysisInput, buildCoverage } from './fixtures/builders';
import { jsonToolResult } from '../src/mcp/result';
import * as chat from '../src/automation/clients';
import { accountState } from '../src/automation/state/budget';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';

const actor = buildActor({ userId: 'owner-sub', clientId: 'workflow-client' });

function upstream() {
  return vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/contacts/2'))
      return Response.json({ payload: { id: 2, name: 'Synthetic Contact', email: 'synthetic@example.com' } });
    if (url.pathname.endsWith('/attachments')) return Response.json({ payload: [] });
    if (url.pathname.endsWith('/messages'))
      return Response.json({
        payload: [
          {
            id: 201,
            conversation_id: 101,
            content: 'Synthetic request',
            message_type: 0,
            sender: { type: 'contact', id: 2 },
          },
        ],
      });
    if (url.pathname.endsWith('/conversations/101'))
      return Response.json({
        id: 101,
        inbox_id: 4101,
        meta: { sender: { id: 2, name: 'Synthetic Contact', email: 'synthetic@example.com' } },
      });
    return Response.json({ data: [] });
  });
}

afterEach(() => vi.unstubAllGlobals());
const configured = () => testEnv({ AGENDOR_CHAT_TOKEN: 'unit-chat-token', AGENDOR_CHAT_ACCOUNT_ID: '123' });
const automationNames = [
  'preflight_sync',
  'discover_pending',
  'prepare_sync',
  'submit_analysis',
  'apply_plan',
  'get_operation',
  'get_customer_context',
  'list_reviews',
  'list_audit',
  'resolve_review',
  'get_status',
  'update_policy',
  'reprocess',
].map((n) => `automation_${n}`);

describe('agent workflow MCP boundary', () => {
  it('publishes exactly 44 tools when both products are configured', async () => {
    const { data } = await rpc('tools/list', {}, configured());
    expect(data.result.tools).toHaveLength(44);
    for (const name of automationNames) {
      const tool = data.result.tools.find((t: { name: string }) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool._meta.securitySchemes[0].type).toBe('oauth2');
      expect(tool.annotations.readOnlyHint).toBe(
        name.includes('_get_') || name.includes('_list_') || name === 'automation_preflight_sync',
      );
    }
  });

  it('requires the full process scope set before any upstream request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const scopes of [['automation:process'], ['automation:process', 'chat:read'], ['chat:read', 'crm:read']]) {
      const { data } = await callTool(
        'automation_prepare_sync',
        { requestId: 'request-1', target: { kind: 'conversation', conversationId: 101 }, mode: 'preview' },
        configured(),
        scopes,
      );
      expect(data.result?.isError).toBe(true);
      expect(JSON.parse(data.result.content[0].text).error.code).toBe('MCP_UNAUTHORIZED');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads empty status and reviews without creating work or calling upstream', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const env = configured();
    const { data } = await callTool('automation_get_status', {}, env, ['automation:read']);
    expect(data.result?.isError).not.toBe(true);
    expect(JSON.parse(data.result.content[0].text)).toMatchObject({
      mode: 'disabled',
      policyVersion: 1,
      pendingReviews: 0,
      pendingOperations: 0,
    });
    const reviews = await callTool('automation_list_reviews', {}, env, ['automation:read', 'chat:read', 'crm:read']);
    expect(JSON.parse(reviews.data.result.content[0].text)).toMatchObject({ reviews: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('persists the preview work, analysis and plan across eviction', async () => {
    const env = configured();
    budgetMock(env).mockResolvedValue({ allowed: true, reservationId: 'test' });
    const fetch = upstream();
    vi.stubGlobal('fetch', fetch);
    const service = createAutomationService(env, actor);
    await service.updatePolicy({
      expectedVersion: 1,
      patch: { mode: 'preview', capabilities: ['crm:create', 'crm:enrich', 'crm:write'] },
    });

    const prepared = await service.prepare({
      requestId: 'preview-request',
      target: { kind: 'conversation', conversationId: 101 },
      mode: 'preview',
    });
    expect(prepared.state).toBe('ready');
    if (prepared.state !== 'ready') return;
    expect(prepared.work.snapshot.conversations[0]?.messages[0]?.id).toBe(201);
    expect(fetch.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);

    const analysis = plannerAnalysis();
    analysis.customerSelection = { kind: 'new', entity: 'person', record: { name: 'Synthetic Contact' } };
    analysis.demands = [];
    const submission = buildAnalysisInput({
      workId: prepared.work.workId,
      leaseToken: prepared.work.leaseToken,
      expectedSnapshotVersion: prepared.work.snapshotVersion,
      analysis,
    });
    const plan = await service.submit(submission);
    expect(plan.state).toBe('review');

    const stub = accountState(env);
    await evictDurableObject(env.AUTOMATION_STATE.get(stub.id));
    expect(JSON.parse((await stub.getServicePlan(plan.planId))!)).toMatchObject({
      plan,
      workflow: { analysis, lease: { mode: 'preview' }, work: prepared.work },
    });

    const replay = await service.prepare({
      requestId: 'preview-request',
      target: { kind: 'conversation', conversationId: 101 },
      mode: 'preview',
    });
    expect(replay).toEqual(prepared);
    expect(await createAutomationService(env, actor).submit(submission)).toEqual(plan);

    await runInDurableObject(env.AUTOMATION_STATE.get(stub.id), (_instance, ctx) => {
      expect(ctx.storage.sql.exec('SELECT work_id FROM snapshot_manifest').toArray()).toEqual([
        { work_id: prepared.work.workId },
      ]);
      expect(ctx.storage.sql.exec('SELECT * FROM execution_operations').toArray()).toEqual([]);
    });
    expect(fetch.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
  });

  it('binds submission to its actor, lease, versions and current source manifest', async () => {
    const env = configured();
    budgetMock(env).mockResolvedValue({ allowed: true, reservationId: 'test' });
    vi.stubGlobal('fetch', upstream());
    const service = createAutomationService(env, actor);
    const prepared = await service.prepare({
      requestId: 'scoped-request',
      target: { kind: 'conversation', conversationId: 101 },
      mode: 'preview',
    });
    expect(prepared.state).toBe('ready');
    if (prepared.state !== 'ready') return;

    const input = buildAnalysisInput({
      workId: prepared.work.workId,
      leaseToken: prepared.work.leaseToken,
      analysis: plannerAnalysis(),
    });
    for (const changed of [
      { ...input, leaseToken: 'wrong' },
      { ...input, expectedSnapshotVersion: 2 },
      { ...input, expectedContextVersion: 1 },
    ]) {
      await expect(service.submit(changed)).rejects.toThrow();
    }
    await expect(
      createAutomationService(env, { ...actor, clientId: 'another-client' }).submit(input),
    ).rejects.toThrow();
    await expect(service.submit(input)).rejects.toThrow(); // references not in the persisted manifest
  });

  it('returns and binds a persisted continuation after budget deferral', async () => {
    const env = configured();
    vi.stubGlobal('fetch', upstream());
    const budget = budgetMock(env);
    budget.mockResolvedValue({ allowed: false, retryAt: Date.now() + 10_000 });
    const service = createAutomationService(env, actor);
    const deferred = await service.prepare({
      requestId: 'deferred',
      target: { kind: 'conversation', conversationId: 101 },
      mode: 'preview',
    });
    expect(deferred.state).toBe('deferred');
    if (deferred.state !== 'deferred') return;
    expect(deferred.leaseToken).toBeTruthy();
    expect(deferred.continuation).toBeTruthy();

    const resume = {
      requestId: 'resume',
      workId: deferred.workId,
      leaseToken: deferred.leaseToken!,
      continuation: deferred.continuation!,
    };
    await expect(service.prepare({ ...resume, continuation: 'fabricated' })).rejects.toThrow();
    await expect(
      createAutomationService({ ...env, AGENDOR_CHAT_ACCOUNT_ID: '999' }, actor).prepare(resume),
    ).rejects.toThrow();

    budget.mockResolvedValue({ allowed: true, reservationId: 'test' });
    await runInDurableObject(env.AUTOMATION_STATE.get(accountState(env).id), (_instance, ctx) =>
      ctx.storage.sql.exec(
        "UPDATE events SET data = json_set(data, '$.preparationDeferral.nextRetryAt', ?) WHERE event_id = ?",
        '2000-01-01T00:00:00.000Z',
        'workflow:' + deferred.workId,
      ),
    );
    expect((await service.prepare(resume)).state).toBe('ready');
  });

  it('allows management reprocessing without requiring a process grant', async () => {
    const env = configured();
    budgetMock(env).mockResolvedValue({ allowed: true, reservationId: 'test' });
    vi.stubGlobal('fetch', upstream());
    const manager = createAutomationService(env, { ...actor, scopes: ['automation:manage', 'crm:read', 'chat:read'] });
    const result = await manager.reprocess({
      requestId: 'bounded-reprocess',
      target: { kind: 'conversation', conversationId: 101 },
      from: '2026-10-20T00:00:00Z',
      to: '2026-10-27T00:00:00Z',
    });
    expect(result.state).toBe('ready');
  });

  it('bounds a response rather than returning an oversized upstream field', () => {
    const result = jsonToolResult({ text: 'x'.repeat(600_000) });
    expect(result.content[0]!.text.length).toBeLessThan(1000);
    expect(result.isError).toBe(true);
  });

  it('continues persisted catalog preparation under a small per-call limit', async () => {
    const env = configured();
    budgetMock(env).mockResolvedValue({ allowed: true, reservationId: 'test' });
    vi.stubGlobal('fetch', upstream());
    const service = createAutomationService(env, actor);
    await service.updatePolicy({
      expectedVersion: 1,
      patch: { limits: { maxConversations: 1, maxCommands: 10, maxRequests: 1 } },
    });

    const first = await service.prepare({
      requestId: 'catalog-continue',
      target: { kind: 'conversation', conversationId: 101 },
      mode: 'preview',
    });
    expect(first.state).toBe('continue');
    if (first.state !== 'continue') return;

    let current = first;
    for (let count = 0; count < 10; count++) {
      const next = await service.prepare({
        requestId: 'resume',
        workId: current.workId,
        leaseToken: current.leaseToken!,
        continuation: current.continuation,
      });
      if (next.state === 'ready') return;
      expect(next.state).toBe('continue');
      if (next.state !== 'continue') break;
      current = next;
    }
    throw Error('Catalog continuation did not finish');
  });

  it('directs pending callers to separate discovery before choosing or reading a conversation', async () => {
    const fetch = upstream();
    vi.stubGlobal('fetch', fetch);
    const env = configured();
    const { data } = await callTool(
      'automation_prepare_sync',
      { requestId: 'pending', target: { kind: 'pending' }, mode: 'preview' },
      env,
      ['automation:process', 'crm:read', 'chat:read'],
    );
    expect(data.result?.isError).toBe(true);
    expect(JSON.parse(data.result.content[0].text).error.code).toBe('INVALID_INPUT');
    expect(fetch).not.toHaveBeenCalled();
    expect(budgetMock(env)).not.toHaveBeenCalled();
  });
});

it('diagnoses the effective allowlist and storage without upstream calls or work', async () => {
  const env = configured();
  const service = createAutomationService(env, actor);
  await service.updatePolicy({
    expectedVersion: 1,
    patch: { mode: 'preview', allowedInboxIds: [4101, 9999], capabilities: ['crm:create'] },
  });
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);

  const target = { kind: 'conversation', conversationId: 101 };
  const scopes = ['automation:process', 'chat:read', 'crm:read'];
  const diagnose = async (args: object, runtime = env) => {
    const { data } = await callTool('automation_preflight_sync', { target, mode: 'preview', ...args }, runtime, scopes);
    return JSON.parse(data.result.content[0].text);
  };

  expect(await diagnose({ inboxIds: [4101], limits: { maxMessagePages: 1, maxAttachmentPages: 0 } })).toMatchObject({
    state: 'ready_for_scope_check',
    effectiveMode: 'preview',
    policyVersion: 2,
    allowedInboxIds: [4101],
    identity: { userId: expect.any(String), clientId: expect.any(String) },
    scope: { target, inboxIds: [4101], conversationVerification: 'required_at_prepare' },
    limits: { maxConversations: 1, maxMessagePages: 1, maxAttachmentPages: 0 },
    persistence: { available: true },
    concurrency: { available: true },
  });
  expect(await diagnose({ inboxIds: [9999] })).toMatchObject({
    state: 'blocked',
    reason: 'INBOX_SCOPE_NOT_AUTHORIZED',
  });
  expect(await diagnose({}, { ...env, AUTOMATION_STATE: undefined as never })).toMatchObject({
    state: 'blocked',
    effectiveMode: null,
    persistence: { available: false },
    concurrency: { available: false },
  });

  const stub = accountState(env);
  await runInDurableObject(env.AUTOMATION_STATE.get(stub.id), (_instance, ctx) => {
    for (const table of ['work', 'snapshot_manifest', 'plans', 'execution_operations', 'budget']) {
      expect(ctx.storage.sql.exec('SELECT * FROM ' + table).toArray()).toEqual([]);
    }
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(budgetMock(env)).not.toHaveBeenCalled();
});

it.each([{}, { inbox_id: 9999 }, { inbox_id: 4101, meta: { inbox: { id: 4102 } } }, { inbox_id: 4101, id: 102 }])(
  'stops at the scope probe for unproven detail %j',
  async (detail) => {
    const env = configured();
    budgetMock(env).mockResolvedValue({ allowed: true, reservationId: 'test' });
    const fetch = vi.fn(async () => Response.json({ id: 101, ...detail }));
    vi.stubGlobal('fetch', fetch);
    const service = createAutomationService(env, actor);
    await expect(
      service.prepare({ requestId: 'deny', target: { kind: 'conversation', conversationId: 101 }, mode: 'preview' }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it('revalidates the canonical inbox before returning a completed replay', async () => {
  const env = configured();
  budgetMock(env).mockResolvedValue({ allowed: true, reservationId: 'test' });
  const fetch = upstream();
  vi.stubGlobal('fetch', fetch);
  const service = createAutomationService(env, actor);
  const input = {
    requestId: 'replay',
    target: { kind: 'conversation' as const, conversationId: 101 },
    mode: 'preview' as const,
  };
  expect((await service.prepare(input)).state).toBe('ready');

  fetch.mockClear().mockResolvedValueOnce(Response.json({ id: 101, inbox_id: 9999 }));
  await expect(service.prepare(input)).rejects.toMatchObject({ code: 'MCP_UNAUTHORIZED' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('enforces page caps and refuses a mode or inbox expansion', async () => {
  const env = configured();
  budgetMock(env).mockResolvedValue({ allowed: true, reservationId: 'test' });
  const fetch = upstream();
  vi.stubGlobal('fetch', fetch);
  const service = createAutomationService(env, actor);
  await service.updatePolicy({ expectedVersion: 1, patch: { mode: 'preview', capabilities: ['crm:create'] } });

  const input = {
    requestId: 'bounded',
    target: { kind: 'conversation' as const, conversationId: 101 },
    mode: 'preview' as const,
  };
  await expect(service.prepare({ ...input, mode: 'apply' })).rejects.toThrow();
  await expect(service.prepare({ ...input, inboxIds: [4101, 9999] })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();

  fetch.mockImplementation(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/conversations/101')) return Response.json({ id: 101, inbox_id: 4102 });
    if (path.endsWith('/messages'))
      return Response.json({ payload: Array.from({ length: 100 }, (_, i) => ({ id: i + 2 })) });
    return Response.json({ data: [] });
  });

  const result = await service.prepare({
    ...input,
    inboxIds: [4102],
    limits: { maxMessagePages: 1, maxAttachmentPages: 0 },
  });
  expect(result).toMatchObject({
    state: 'ready',
    work: {
      coverage: {
        complete: false,
        missingReasons: expect.arrayContaining(['message_page_limit', 'attachment_page_limit']),
      },
    },
  });
  const paths = fetch.mock.calls.map(([request]) => new URL(request.url).pathname);
  expect(paths.filter((path) => path.endsWith('/messages'))).toHaveLength(1);
  expect(paths.some((path) => path.endsWith('/attachments'))).toBe(false);
});

it('revalidates a CRM-only continuation before reading another catalog page', async () => {
  const env = configured();
  budgetMock(env).mockResolvedValue({ allowed: true, reservationId: 'test' });
  const fetch = upstream();
  vi.stubGlobal('fetch', fetch);
  const service = createAutomationService(env, actor);
  await service.updatePolicy({
    expectedVersion: 1,
    patch: { mode: 'preview', limits: { maxConversations: 1, maxCommands: 10, maxRequests: 1 } },
  });

  const first = await service.prepare({
    requestId: 'partially-prepared',
    target: { kind: 'conversation', conversationId: 101 },
    mode: 'preview',
    inboxIds: [4101],
  });
  if (first.state !== 'continue' || !first.leaseToken) throw Error('Expected catalog continuation');

  const resume = {
    requestId: 'continue-prepare',
    workId: first.workId,
    leaseToken: first.leaseToken,
    continuation: first.continuation,
  };
  const stub = accountState(env);
  await evictDurableObject(env.AUTOMATION_STATE.get(stub.id));
  fetch.mockClear().mockResolvedValueOnce(Response.json({ id: 101, inbox_id: 4102 }));
  await expect(createAutomationService(env, actor).prepare(resume)).rejects.toMatchObject({ code: 'MCP_UNAUTHORIZED' });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(new URL(fetch.mock.calls[0]![0].url).pathname).toBe('/api/v1/accounts/123/conversations/101');
});

it('renews an expired preparation with a new snapshot and rejects the old token and version', async () => {
  const env = configured();
  budgetMock(env).mockResolvedValue({ allowed: true, reservationId: 'test' });
  vi.stubGlobal('fetch', upstream());
  const service = createAutomationService(env, actor);
  const start = {
    requestId: 'lease-renewal',
    target: { kind: 'conversation' as const, conversationId: 101 },
    mode: 'preview' as const,
  };

  const first = await service.prepare(start);
  if (first.state !== 'ready') throw Error('Expected initial snapshot');

  const stub = accountState(env);
  await runInDurableObject(env.AUTOMATION_STATE.get(stub.id), (_instance, ctx) => {
    ctx.storage.sql.exec('UPDATE work SET expires_at = 0 WHERE work_id = ?', first.work.workId);
  });

  const next = await service.prepare(start);
  if (next.state !== 'ready') throw Error('Expected renewed snapshot');
  expect(next.work.workId).toBe(first.work.workId);
  expect(next.work.leaseToken).not.toBe(first.work.leaseToken);
  expect(next.work.snapshotVersion).toBe(first.work.snapshotVersion + 1);

  const stale = buildAnalysisInput({
    workId: first.work.workId,
    leaseToken: next.work.leaseToken,
    expectedSnapshotVersion: first.work.snapshotVersion,
    analysis: plannerAnalysis(),
  });
  await expect(service.submit(stale)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    service.submit({ ...stale, leaseToken: first.work.leaseToken, expectedSnapshotVersion: next.work.snapshotVersion }),
  ).rejects.toThrow();
});

it('verifies all customer conversation IDs before reading any of their content', async () => {
  const env = configured();
  budgetMock(env).mockResolvedValue({ allowed: true, reservationId: 'test' });
  const stub = accountState(env);
  await runInDurableObject(env.AUTOMATION_STATE.get(stub.id), (_instance, ctx) => {
    const evidenceRefs = [101, 102].map((id) => ({ kind: 'message', id: id + ':201', revision: 'synthetic' }));
    ctx.storage.sql.exec(
      'INSERT INTO contexts VALUES (?, ?, 1, 1, ?, ?)',
      'customer-synthetic',
      'work-synthetic',
      JSON.stringify({ evidenceRefs }),
      Date.now() + 60_000,
    );
  });

  const fetch = vi.fn(async (request: Request) => {
    const id = Number(new URL(request.url).pathname.split('/').at(-1));
    return Response.json({ id, inbox_id: id === 101 ? 4101 : 9999, meta: { sender: { id: 2 } } });
  });
  vi.stubGlobal('fetch', fetch);

  const service = createAutomationService(env, actor);
  await expect(
    service.prepare({
      requestId: 'mixed-customer',
      target: { kind: 'customer', customerId: 'customer-synthetic' },
      mode: 'preview',
    }),
  ).rejects.toMatchObject({ code: 'MCP_UNAUTHORIZED' });
  expect(fetch.mock.calls.map(([req]) => new URL(req.url).pathname)).toEqual([
    '/api/v1/accounts/123/conversations/101',
    '/api/v1/accounts/123/conversations/102',
  ]);
});

it('recovers the same preparation after a simulated SQLite snapshot persistence failure', async () => {
  const env = configured();
  budgetMock(env).mockResolvedValue({ allowed: true, reservationId: 'test' });
  vi.stubGlobal('fetch', upstream());
  const real = accountState(env);
  let failures = 1;
  const wrapped = new Proxy(real, {
    get(target, property) {
      if (property === 'installSnapshot') {
        return async (...args: Parameters<typeof real.installSnapshot>) => {
          if (failures-- > 0) throw new Error('synthetic persistence outage');
          return real.installSnapshot(...args);
        };
      }
      return Reflect.get(target, property);
    },
  });
  const namespace = new Proxy(env.AUTOMATION_STATE, {
    get(target, property) {
      if (property === 'getByName') return () => wrapped;
      return Reflect.get(target, property);
    },
  });

  const service = createAutomationService({ ...env, AUTOMATION_STATE: namespace }, actor);
  const request = {
    requestId: 'snapshot-outage',
    target: { kind: 'conversation' as const, conversationId: 101 },
    mode: 'preview' as const,
    limits: { maxMessagePages: 1, maxAttachmentPages: 0 },
  };
  await expect(service.prepare(request)).rejects.toThrow('synthetic persistence outage');

  const again = await service.prepare(request);
  expect(again.state).toBe('ready');
  if (again.state !== 'ready') throw Error('Expected a prepared work');
  expect(again.work.coverage.complete).toBe(false);
  expect(again.work.coverage.missingReasons).toContain('attachment_page_limit');

  const replay = await service.prepare(request);
  expect(replay).toEqual(again);
});

it('routes a mismatched message page to review and never treats it as a ready snapshot', async () => {
  const env = configured();
  budgetMock(env).mockResolvedValue({ allowed: true, reservationId: 'test' });
  const fetch = upstream();
  vi.stubGlobal('fetch', fetch);
  const adapter = chat.createAgendorChatClient(env);
  vi.spyOn(chat, 'createAgendorChatClient').mockReturnValue({
    ...adapter,
    listMessages: async () => ({
      conversationId: 999,
      messages: [],
      coverage: buildCoverage(),
    }),
  });

  const result = await createAutomationService(env, actor).prepare({
    requestId: 'bad-conversation-page',
    target: { kind: 'conversation', conversationId: 101 },
    mode: 'preview',
    limits: { maxMessagePages: 1, maxAttachmentPages: 0 },
  });
  expect(result.state).toBe('review');
  expect(fetch.mock.calls.some(([request]) => new URL(request.url).hostname === 'api.agendor.com.br')).toBe(false);
});

it('excludes concurrent preparation of the same work and releases the lock on completion', async () => {
  const env = configured();
  budgetMock(env).mockResolvedValue({ allowed: true, reservationId: 'test' });
  const original = upstream();
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    started = resolve;
  });
  let firstScope = true;
  const fetch = vi.fn(async (request: Request) => {
    if (new URL(request.url).pathname.endsWith('/conversations/101') && firstScope) {
      firstScope = false;
      started();
      await blocked;
    }
    return original(request);
  });
  vi.stubGlobal('fetch', fetch);

  const service = createAutomationService(env, actor);
  const request = {
    requestId: 'same-concurrent-work',
    target: { kind: 'conversation' as const, conversationId: 101 },
    mode: 'preview' as const,
    limits: { maxMessagePages: 1, maxAttachmentPages: 0 },
  };
  const first = service.prepare(request);
  await reached;
  try {
    await expect(service.prepare(request)).rejects.toMatchObject({ code: 'UPSTREAM_CONFLICT', retryable: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    release();
  }
  const ready = await first;
  expect(ready.state).toBe('ready');
  expect(await service.prepare(request)).toEqual(ready);
});
