/// <reference types="vite/client" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import { accountState } from '../src/automation/state/budget';
import { createAutomationService } from '../src/automation/service';
import { buildActor } from './fixtures/builders';
import { budgetMock, testEnv } from './helpers';
import { readToolJson, type JsonRpcEnvelope, type ToolCallResult } from './helpers/json';
import { callTool } from './mcp-helper';

const srcFiles = import.meta.glob<string>('../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function extractSafeErrorCalls(source: string): string[] {
  const calls: string[] = [];
  const pattern = /\bnew\s+SafeError\s*\(/g;
  for (const match of source.matchAll(pattern)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let quote: string | undefined;
    let escaped = false;
    let index = start;
    for (; index < source.length && depth > 0; index++) {
      const ch = source[index]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quote) {
        if (ch === '\\') escaped = true;
        else if (ch === quote) quote = undefined;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    calls.push(source.slice(start, Math.max(start, index - 1)));
  }
  return calls;
}

const configured = () => testEnv({ AGENDOR_CHAT_TOKEN: 'unit-chat-token', AGENDOR_CHAT_ACCOUNT_ID: '123' });

function parseToolBody(data: JsonRpcEnvelope<ToolCallResult>) {
  return readToolJson<{
    state?: string;
    cursor?: string;
    error?: { code: string; status?: number; requiredScope?: string };
  }>(data);
}

afterEach(() => vi.unstubAllGlobals());

describe('error taxonomy', () => {
  it('returns MCP_UNAUTHORIZED when a required OAuth scope is missing', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    const { data } = await callTool('automation_get_status', {}, configured(), ['crm:read']);
    expect(data.result?.isError).toBe(true);
    expect(parseToolBody(data).error).toMatchObject({
      code: 'MCP_UNAUTHORIZED',
      status: 403,
      requiredScope: 'automation:read',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns POLICY_BLOCKED when a conversation inbox is outside the allowlist', async () => {
    const env = configured();
    budgetMock(env).mockResolvedValue({ allowed: true, reservationId: 'test' });
    const fetch = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname.endsWith('/conversations/101')) {
        return Response.json({ id: 101, inbox_id: 9999 });
      }
      throw new Error('Unexpected upstream read');
    });
    vi.stubGlobal('fetch', fetch);

    const { data } = await callTool(
      'automation_prepare_sync',
      {
        requestId: 'taxonomy-policy-blocked',
        target: { kind: 'conversation', conversationId: 101 },
        mode: 'preview',
      },
      env,
      ['automation:process', 'chat:read', 'crm:read'],
    );
    expect(data.result?.isError).toBe(true);
    expect(parseToolBody(data).error).toMatchObject({
      code: 'POLICY_BLOCKED',
      status: 403,
    });
  });

  it('returns WORK_STALE when a discovery cursor is expired', async () => {
    const env = configured();
    budgetMock(env).mockResolvedValue({ allowed: true, reservationId: 'test' });
    const actor = buildActor({
      userId: 'owner-sub',
      clientId: 'taxonomy-client',
      scopes: ['automation:manage', 'automation:process', 'chat:read', 'crm:read'],
    });
    await createAutomationService(env, actor).updatePolicy({ expectedVersion: 1, patch: { mode: 'preview' } });

    const timestamp = Math.floor(Date.now() / 1000);
    const fetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/inboxes')) {
        return Response.json({ payload: [{ id: 4101 }, { id: 4102 }], links: { next: null } });
      }
      return Response.json({
        data: { payload: [{ id: 101, inbox_id: 4101, timestamp, status: 'pending' }] },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const scopes = ['automation:process', 'chat:read', 'crm:read'];
    const first = await callTool('automation_discover_pending', { inboxIds: [4101] }, env, scopes);
    expect(first.data.result?.isError).not.toBe(true);
    const cursor = parseToolBody(first.data).cursor;
    expect(typeof cursor).toBe('string');

    const stub = env.AUTOMATION_STATE.get(accountState(env).id);
    await runInDurableObject(stub, (_instance, ctx) => {
      ctx.storage.sql.exec('UPDATE pending_cursors SET expires_at = 0 WHERE cursor = ?', cursor);
    });

    const second = await callTool('automation_discover_pending', { inboxIds: [4101], cursor }, env, scopes);
    expect(second.data.result?.isError).toBe(true);
    expect(parseToolBody(second.data).error).toMatchObject({
      code: 'WORK_STALE',
      status: 409,
    });
  });

  it('returns CONFLICT when a requestId is reused with a different payload', async () => {
    const env = configured();
    budgetMock(env).mockResolvedValue({ allowed: true, reservationId: 'test' });
    const fetch = vi.fn(async () => Response.json({ data: { id: 99, name: 'Synthetic Contact' } }));
    vi.stubGlobal('fetch', fetch);

    const requestId = 'taxonomy-conflict-request';
    const first = await callTool('crm_create_person', { requestId, record: { name: 'Synthetic Contact' } }, env, [
      'crm:create',
    ]);
    expect(first.data.result?.isError).not.toBe(true);

    const second = await callTool('crm_create_person', { requestId, record: { name: 'Different Contact' } }, env, [
      'crm:create',
    ]);
    expect(second.data.result?.isError).toBe(true);
    expect(parseToolBody(second.data).error).toMatchObject({
      code: 'CONFLICT',
      status: 409,
    });
  });

  it('throws MCP_UNAUTHORIZED in src/ only from src/auth.ts and automationActor', () => {
    const entries = Object.entries(srcFiles);
    expect(entries.length).toBeGreaterThan(30);

    const throwingFiles: string[] = [];
    for (const [file, content] of entries) {
      const calls = extractSafeErrorCalls(content).filter((args) => /['"]MCP_UNAUTHORIZED['"]/.test(args));
      if (calls.length > 0) throwingFiles.push(file);

      if (file === '../src/auth.ts') continue;
      if (file === '../src/automation/usecases/context.ts') {
        const actorMatch = content.match(/export function automationActor\b[\s\S]*?\n\}/);
        expect(actorMatch).not.toBeNull();
        expect(actorMatch![0]).toMatch(/new\s+SafeError\s*\(\s*['"]MCP_UNAUTHORIZED['"]/);
        expect(content.replace(actorMatch![0], '')).not.toContain('MCP_UNAUTHORIZED');
        continue;
      }
      if (file === '../src/shared/errors.ts') {
        expect(content.replace(/\|\s*'MCP_UNAUTHORIZED'/, '')).not.toContain('MCP_UNAUTHORIZED');
        continue;
      }
      for (const line of content.split(/\r?\n/)) {
        if (!line.includes('MCP_UNAUTHORIZED')) continue;
        expect(line, `${file} may only inspect MCP_UNAUTHORIZED`).toMatch(/===\s*['"]MCP_UNAUTHORIZED['"]/);
      }
    }

    expect(throwingFiles.sort()).toEqual(['../src/auth.ts', '../src/automation/usecases/context.ts']);
  });

  it('leaves no SafeError with INVALID_INPUT and status 409 anywhere in src/', () => {
    const entries = Object.entries(srcFiles);
    expect(entries.length).toBeGreaterThan(30);

    for (const [file, content] of entries) {
      for (const args of extractSafeErrorCalls(content)) {
        const hasInvalidInput = /['"]INVALID_INPUT['"]/.test(args);
        const hasConflictStatus = /\b409\b/.test(args);
        expect(hasInvalidInput && hasConflictStatus, `${file} must not construct INVALID_INPUT with 409`).toBe(false);
      }
      if (!content.includes('INVALID_INPUT')) continue;
      expect(['../src/shared/errors.ts', '../src/agendor/crm/schemas.ts']).toContain(file);
    }
  });
});
