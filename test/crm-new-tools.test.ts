import { afterEach, describe, expect, it, vi } from 'vitest';
import { callTool, rpc } from './mcp-helper';
import { testEnv } from './helpers';
import { executeDirectCommand } from '../src/automation/direct';
import { createAutomationService } from '../src/automation/service';
import { runInDurableObject } from 'cloudflare:test';
import { handleAutomationQueue } from '../src/automation/queue';
import { accountState } from '../src/automation/state/budget';
const actor = {
  userId: 'operator',
  clientId: 'direct-client',
  scopes: ['crm:create'],
  expiresAt: Date.now() + 600_000,
};

afterEach(() => vi.unstubAllGlobals());
const requestId = 'e4c257cd-73dc-4835-bfa7-d02652181fd4';
const createNames = ['crm_create_organization', 'crm_create_person', 'crm_create_deal', 'crm_create_task'];
const enrichNames = ['crm_enrich_organization', 'crm_enrich_person', 'crm_enrich_deal', 'crm_update_task'];
describe('direct coordinated CRM tools', () => {
  it('does not expose creation to a legacy write grant', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { data } = await callTool(
      'crm_create_person',
      { requestId, record: { name: 'Synthetic Contact' } },
      testEnv(),
      ['crm:write'],
    );
    expect(data.result?.isError).toBe(true);
    expect(JSON.parse(data.result.content[0].text).error.requiredScope).toBe('crm:create');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('publishes closed inputs and separate direct capabilities', async () => {
    const { data } = await rpc('tools/list');
    for (const name of [...createNames, ...enrichNames]) {
      const tool = data.result.tools.find((t: { name: string }) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.required).toContain('requestId');
      expect(tool.annotations.readOnlyHint).toBe(false);
      expect(tool._meta.securitySchemes).toEqual([
        { type: 'oauth2', scopes: [createNames.includes(name) ? 'crm:create' : 'crm:enrich'] },
      ]);
    }
  });
  it('rejects account, routes and caller capability claims without upstream access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const extra of [
      { accountId: 'other' },
      { endpoint: 'https://example.com' },
      { requiredCapabilities: ['crm:create'] },
    ]) {
      const { data } = await callTool(
        'crm_create_person',
        { requestId, record: { name: 'Synthetic Contact' }, ...extra },
        testEnv(),
        ['crm:create'],
      );
      expect(data.error || data.result?.isError).toBeTruthy();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reserves one command, reads back the ID, and rejects conflicting request reuse', async () => {
    const fetch = vi.fn(async (request: Request) => Response.json({ data: { id: 99, name: 'Synthetic Contact' } }));
    vi.stubGlobal('fetch', fetch);
    const env = testEnv();
    const input = { requestId, record: { name: 'Synthetic Contact' } };
    const result = await executeDirectCommand(env, actor, 'crm_create_person', input);
    expect(result.state).toBe('applied');
    expect(result.receipts[0]?.crmRef).toEqual({ kind: 'person', id: 99 });
    expect(fetch.mock.calls.map(([r]) => r.method)).toEqual(['POST', 'GET']);
    await expect(executeDirectCommand(env, actor, 'crm_create_person', input)).resolves.toEqual(result);
    await expect(
      executeDirectCommand(env, actor, 'crm_create_person', { ...input, record: { name: 'Another' } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not redispatch a POST after an uncertain transport outcome', async () => {
    const fetch = vi.fn(async () => {
      throw Error('secret internal transport failure');
    });
    vi.stubGlobal('fetch', fetch);
    const env = testEnv();
    const input = { requestId, record: { name: 'Synthetic Contact' } };
    const result = await executeDirectCommand(env, actor, 'crm_create_person', input);
    expect(result.state).toBe('uncertain');
    expect(result.pendingReasons).toContain('UPSTREAM_EFFECT_UNCERTAIN');
    await executeDirectCommand(env, actor, 'crm_create_person', input);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('coordinates legacy updates with only crm:write and preserves the response shape', async () => {
    const fetch = vi.fn(async (_request: Request) => Response.json({ data: { id: 42, title: 'Synthetic' } }));
    vi.stubGlobal('fetch', fetch);
    const { data } = await callTool('crm_update_deal', { id: 42, patch: { title: 'Synthetic' } }, testEnv(), [
      'crm:write',
    ]);
    expect(data.result.isError).not.toBe(true);
    expect(JSON.parse(data.result.content[0].text)).toEqual({ id: 42, updatedFields: ['title'] });
    expect(fetch.mock.calls.map(([r]) => (r as Request).method)).toEqual(['PUT', 'GET']);
  });
  it('releases a confirmed direct target for the next explicit update', async () => {
    let current = 'First';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) => {
        if (request.method === 'PUT') current = ((await request.json()) as { name: string }).name;
        return Response.json({ data: { id: 42, name: current } });
      }),
    );
    const env = testEnv();
    const editor = { ...actor, scopes: ['crm:enrich'] };
    expect(
      (
        await executeDirectCommand(env, editor, 'crm_enrich_person', {
          requestId: 'first',
          id: 42,
          patch: { name: 'First' },
        })
      ).state,
    ).toBe('applied');
    expect(
      (
        await executeDirectCommand(env, editor, 'crm_enrich_person', {
          requestId: 'second',
          id: 42,
          patch: { name: 'Second' },
        })
      ).state,
    ).toBe('applied');
  });
  it('reconciles an uncertain operation using only GETs and its original actor', async () => {
    let sent = false;
    const fetch = vi.fn(async (request: Request) => {
      if (request.method === 'POST') {
        sent = true;
        throw Error('lost response');
      }
      const record = { id: 99, name: 'Synthetic Contact', contact: { email: 'synthetic@example.com' } };
      return Response.json(
        new URL(request.url).pathname.endsWith('/people')
          ? { data: sent ? [record] : [], links: { next: null } }
          : { data: record },
      );
    });
    vi.stubGlobal('fetch', fetch);
    const env = testEnv();
    const result = await executeDirectCommand(env, actor, 'crm_create_person', {
      requestId,
      record: { name: 'Synthetic Contact', contact: { email: 'synthetic@example.com' } },
    });
    const service = createAutomationService(env, { ...actor, scopes: ['automation:read'] });
    await expect(
      createAutomationService(env, { ...actor, clientId: 'other', scopes: ['automation:read'] }).getOperation(
        result.operationId,
      ),
    ).rejects.toThrow();
    expect((await service.getOperation(result.operationId)).state).toBe('applied');
    expect(fetch.mock.calls.filter(([r]) => r.method === 'POST')).toHaveLength(1);
    expect(fetch.mock.calls.slice(1).every(([r]) => r.method === 'GET')).toBe(true);
  });
  it('queues reference-only recovery after a direct 429 and retries the reserved command once', async () => {
    let attempts = 0;
    const fetch = vi.fn(async (request: Request) => {
      if (request.method === 'POST' && ++attempts === 1)
        return new Response('', { status: 429, headers: { 'Retry-After': '0' } });
      return Response.json({ data: { id: 99, name: 'Synthetic Contact' } });
    });
    vi.stubGlobal('fetch', fetch);
    const env = testEnv();
    const send = vi.fn(async (_body: unknown) => undefined);
    env.AUTOMATION_QUEUE = new Proxy(env.AUTOMATION_QUEUE, {
      get(target, prop) {
        if (prop === 'send') return send;
        return Reflect.get(target, prop);
      },
    });
    const input = { requestId, record: { name: 'Synthetic Contact' } };
    const first = await executeDirectCommand(env, actor, 'crm_create_person', input);
    expect(first.state).toBe('queued');
    expect(send).toHaveBeenCalledWith({ accountKey: 'elotenant', operationId: first.operationId, version: 1 });
    await executeDirectCommand(env, actor, 'crm_create_person', input);
    expect(send).toHaveBeenCalledTimes(2);
    expect(attempts).toBe(1);
    await runInDurableObject(env.AUTOMATION_STATE.get(accountState(env).id), (_instance, ctx) =>
      ctx.storage.sql.exec('UPDATE execution_commands SET next_attempt_at = 0').toArray(),
    );
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = { messages: [{ body: send.mock.calls[0]![0], ack, retry }] };
    await handleAutomationQueue(batch, env);
    await handleAutomationQueue(batch, env);
    expect((await accountState(env).getOperation(first.operationId))?.status.state).toBe('applied');
    expect(attempts).toBe(2);
    expect(fetch.mock.calls.map(([r]) => r.method)).toEqual(['POST', 'POST', 'GET']);
    expect(ack).toHaveBeenCalledTimes(2);
    expect(retry).not.toHaveBeenCalled();
    await expect(executeDirectCommand(env, actor, 'crm_create_person', input)).resolves.toMatchObject({
      state: 'applied',
      operationId: first.operationId,
    });
  });
});
