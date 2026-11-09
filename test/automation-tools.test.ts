import { afterEach, describe, expect, it, vi } from 'vitest';
import { callTool, rpc } from './mcp-helper';
import { testEnv } from './helpers';
import { createAutomationService } from '../src/automation/service';
import { budgetMock } from './helpers';
import { plannerAnalysis } from './fixtures/planner';
import { jsonToolResult } from '../src/mcp/result';

const actor = { userId: 'owner-sub', clientId: 'workflow-client', scopes: ['automation:process', 'automation:read', 'automation:manage', 'crm:read', 'chat:read', 'crm:create', 'crm:enrich', 'crm:write'], expiresAt: Date.now() + 600_000 };
function upstream() {
  return vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if(url.pathname.endsWith('/contacts/2'))return Response.json({payload:{id:2,name:'Synthetic Contact',email:'synthetic@example.com'}});
    if (url.pathname.endsWith('/attachments')) return Response.json({ payload: [] });
    if (url.pathname.endsWith('/messages')) return Response.json({ payload: [{ id: 201, conversation_id: 101, content: 'Synthetic request', message_type: 0, sender: { type: 'contact', id: 2 } }] });
    if (url.pathname.endsWith('/conversations/101')) return Response.json({ id: 101, inbox_id:4101, meta: { sender: { id: 2, name: 'Synthetic Contact', email: 'synthetic@example.com' } } });
    return Response.json({ data: [] });
  });
}

afterEach(() => vi.unstubAllGlobals());
const configured = () => testEnv({ AGENDOR_CHAT_TOKEN: 'unit-chat-token', AGENDOR_CHAT_ACCOUNT_ID: '123' });
const automationNames = ['prepare_sync', 'submit_analysis', 'apply_plan', 'get_operation', 'get_customer_context', 'list_reviews', 'list_audit', 'resolve_review', 'get_status', 'update_policy', 'reprocess'].map(n => `automation_${n}`);
describe('agent workflow MCP boundary', () => {
  it('publishes exactly 42 tools when both products are configured', async () => {
    const { data } = await rpc('tools/list', {}, configured());
    expect(data.result.tools).toHaveLength(42);
    for (const name of automationNames) {
      const tool = data.result.tools.find((t: {name: string}) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool._meta.securitySchemes[0].type).toBe('oauth2');
      expect(tool.annotations.readOnlyHint).toBe(name.includes('_get_') || name.includes('_list_'));
    }
  });
  it('requires the full process scope set before any upstream request', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const scopes of [['automation:process'], ['automation:process', 'chat:read'], ['chat:read', 'crm:read']]) {
      const { data } = await callTool('automation_prepare_sync', { requestId: 'request-1', target: { kind: 'conversation', conversationId: 101 }, mode: 'preview' }, configured(), scopes);
      expect(data.result?.isError).toBe(true);
      expect(JSON.parse(data.result.content[0].text).error.code).toBe('MCP_UNAUTHORIZED');
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reads empty status and reviews without creating work or calling upstream', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const env = configured();
    const { data } = await callTool('automation_get_status', {}, env, ['automation:read']);
    expect(data.result?.isError).not.toBe(true);
    expect(JSON.parse(data.result.content[0].text)).toMatchObject({ mode: 'disabled', policyVersion: 1, pendingReviews: 0, pendingOperations: 0 });
    const reviews = await callTool('automation_list_reviews', {}, env, ['automation:read', 'chat:read', 'crm:read']);
    expect(JSON.parse(reviews.data.result.content[0].text)).toMatchObject({ reviews: [] });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('prepares on demand and persists a preview that rejects apply', async () => {
    const env = configured(); budgetMock(env).mockResolvedValue({ allowed: true, reservationId: 'test' });
    const fetch = upstream(); vi.stubGlobal('fetch', fetch);
    const service = createAutomationService(env, actor);
    const prepared = await service.prepare({ requestId: 'preview-request', target: { kind: 'conversation', conversationId: 101 }, mode: 'preview' });
    expect(prepared.state).toBe('ready');
    if (prepared.state !== 'ready') return;
    expect(prepared.work.snapshot.conversations[0]?.messages[0]?.id).toBe(201);
    expect(fetch.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
    const analysis = plannerAnalysis();
    analysis.customerSelection = { kind: 'new', entity: 'person', record: { name: 'Synthetic Contact' } }; analysis.demands = [];
    const plan = await service.submit({ workId: prepared.work.workId, leaseToken: prepared.work.leaseToken, expectedSnapshotVersion: prepared.work.snapshotVersion, expectedContextVersion: 0, analysis });
    expect(plan.state).toBe('review');
    await expect(service.apply({ planId: plan.planId, planVersion: plan.version, requestId: 'apply-preview' })).rejects.toThrow();
    expect(fetch.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
  });
  it('binds submission to its actor, lease, versions and current source manifest', async () => {
    const env = configured(); budgetMock(env).mockResolvedValue({ allowed: true, reservationId: 'test' }); vi.stubGlobal('fetch', upstream());
    const service = createAutomationService(env, actor);
    const prepared = await service.prepare({ requestId: 'scoped-request', target: { kind: 'conversation', conversationId: 101 }, mode: 'preview' });
    expect(prepared.state).toBe('ready'); if (prepared.state !== 'ready') return;
    const input = { workId: prepared.work.workId, leaseToken: prepared.work.leaseToken, expectedSnapshotVersion: 1, expectedContextVersion: 0, analysis: plannerAnalysis() };
    for (const changed of [{ ...input, leaseToken: 'wrong' }, { ...input, expectedSnapshotVersion: 2 }]) await expect(service.submit(changed)).rejects.toThrow();
    await expect(createAutomationService(env, { ...actor, clientId: 'another-client' }).submit(input)).rejects.toThrow();
    await expect(service.submit(input)).rejects.toThrow(); // references not in the persisted manifest
  });
  it('returns and binds a persisted continuation after budget deferral', async () => {
    const env = configured(); vi.stubGlobal('fetch', upstream());
    const budget = budgetMock(env); budget.mockResolvedValue({ allowed: false, retryAt: Date.now() + 10_000 });
    const service = createAutomationService(env, actor);
    const deferred = await service.prepare({ requestId: 'deferred', target: { kind: 'conversation', conversationId: 101 }, mode: 'preview' });
    expect(deferred.state).toBe('deferred'); if (deferred.state !== 'deferred') return;
    expect(deferred.leaseToken).toBeTruthy(); expect(deferred.continuation).toBeTruthy();
    const resume = { requestId: 'resume', workId: deferred.workId, leaseToken: deferred.leaseToken!, continuation: deferred.continuation! };
    await expect(service.prepare({ ...resume, continuation: 'fabricated' })).rejects.toThrow();
    await expect(createAutomationService({ ...env, AGENDOR_CHAT_ACCOUNT_ID: '999' }, actor).prepare(resume)).rejects.toThrow();
    budget.mockResolvedValue({ allowed: true, reservationId: 'test' });
    expect((await service.prepare(resume)).state).toBe('ready');
  });
  it('allows management reprocessing without requiring a process grant', async () => {
    const env = configured(); budgetMock(env).mockResolvedValue({ allowed: true, reservationId: 'test' }); vi.stubGlobal('fetch', upstream());
    const manager = createAutomationService(env, { ...actor, scopes: ['automation:manage', 'crm:read', 'chat:read'] });
    const result = await manager.reprocess({ requestId: 'bounded-reprocess', target: { kind: 'conversation', conversationId: 101 }, from: '2026-10-20T00:00:00Z', to: '2026-10-27T00:00:00Z' });
    expect(result.state).toBe('ready');
  });
  it('bounds a response rather than returning an oversized upstream field', () => {
    const result = jsonToolResult({ text: 'x'.repeat(600_000) });
    expect(result.content[0]!.text.length).toBeLessThan(1000);
    expect(result.isError).toBe(true);
  });
  it('continues persisted catalog preparation under a small per-call limit', async () => {
    const env = configured(); budgetMock(env).mockResolvedValue({ allowed: true, reservationId: 'test' }); vi.stubGlobal('fetch', upstream());
    const service = createAutomationService(env, actor);
    await service.updatePolicy({ expectedVersion: 1, patch: { limits: { maxConversations: 1, maxCommands: 10, maxRequests: 1 } } });
    const first = await service.prepare({ requestId: 'catalog-continue', target: { kind: 'conversation', conversationId: 101 }, mode: 'preview' });
    expect(first.state).toBe('continue');
    if (first.state !== 'continue') return;
    let current = first;
    for (let count = 0; count < 10; count++) {
      const next = await service.prepare({ requestId: 'resume', workId: current.workId, leaseToken: current.leaseToken!, continuation: current.continuation });
      if (next.state === 'ready') return;
      expect(next.state).toBe('continue'); if (next.state !== 'continue') break; current = next;
    }
    throw Error('Catalog continuation did not finish');
  });
  it('rejects an unsupported pending target before choosing or reading a conversation', async () => {
    const fetch = upstream(); vi.stubGlobal('fetch', fetch); const env = configured();
    const { data } = await callTool('automation_prepare_sync', { requestId: 'pending', target: { kind: 'pending' }, mode: 'preview' }, env, ['automation:process', 'crm:read', 'chat:read']);
    expect(data.result?.isError).toBe(true);
    expect(JSON.parse(data.result.content[0].text).error.code).toBe('INVALID_INPUT');
    expect(fetch).not.toHaveBeenCalled(); expect(budgetMock(env)).not.toHaveBeenCalled();
  });
});
