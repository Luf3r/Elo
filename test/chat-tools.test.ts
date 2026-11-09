import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callTool, rpc } from './mcp-helper';
import { testEnv, budgetMock } from './helpers';

const conversation = {
  id: 456, inbox_id:4101, status: 'open', inbox_name: 'WhatsApp', created_at: 1700000000,
  unread_count: 2, meta: { sender: { name: 'Cliente', phone_number: '+5511999999999', agendor_person_id: 789 } },
  last_non_activity_message: { content: 'Última mensagem privada' },
};
const message = { id: 987, conversation_id: 456, content: 'Texto da mensagem', created_at: 1700000001, private: false, sender_type: 'Contact', sender: { name: 'Cliente' } };

function mockChat() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async request => {
    const url = new URL(request instanceof Request ? request.url : String(request));
    if (url.pathname.endsWith('/profile')) return Response.json({ account_id: 123 });
    if (url.pathname.endsWith('/messages')) return Response.json({ meta: {}, payload: [message] });
    if (url.pathname.endsWith('/456')) return Response.json({ ...conversation, messages: [message] });
    return Response.json({ data: { meta: { all_count: 1 }, payload: [conversation] } });
  });
}

describe('read-only Agendor Chat tools', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('registers read tools only and requires the independent chat scope', async () => {
    const env = testEnv({ AGENDOR_CHAT_TOKEN: 'chat-token', AGENDOR_CHAT_ACCOUNT_ID: '123' });
    const fetch = mockChat();
    const { data } = await rpc('tools/list', {}, env, {}, ['crm:read']);
    const names = data.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('chat_list_conversations');
    expect(names).toContain('chat_get_conversation');
    expect(names).toContain('chat_list_messages');
    for (const name of ['chat_search_contacts', 'chat_get_contact', 'chat_list_contact_conversations', 'chat_list_attachments', 'chat_get_attachment']) expect(names).toContain(name);
    expect(names.filter((name: string) => name.startsWith('chat_'))).toHaveLength(8);
    const denied = await callTool('chat_list_conversations', {}, env, ['crm:read']);
    expect(denied.data.result.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads conversations through fixed GET routes and returns only allowlisted fields', async () => {
    const env = testEnv({ AGENDOR_CHAT_TOKEN: 'chat-token', AGENDOR_CHAT_ACCOUNT_ID: '123' });
    const fetch = mockChat();
    const { data } = await callTool('chat_list_conversations', {}, env, ['chat:read']);
    const text = data.result.content[0].text;
    expect(text).toContain('Última mensagem privada');
    expect(text).toContain('Cliente');
    expect(text).not.toContain('phone_number');
    expect(text).not.toContain('account_id');
    const requests = fetch.mock.calls.map(([request]) => request as Request);
    expect(requests.map(request => new URL(request.url).pathname)).toEqual([
      '/api/v1/accounts/123/conversations',
      '/api/v1/accounts/123/conversations',
    ]);
    expect(new URL(requests[1]!.url).searchParams.get('page')).toBe('2');
    expect(requests.every(request => request.method === 'GET')).toBe(true);
    expect(requests.every(request => new URL(request.url).origin === 'https://chat.agendor.com.br')).toBe(true);
  });

  it('reads a conversation and messages by positive numeric ID with filtered output', async () => {
    const env = testEnv({ AGENDOR_CHAT_TOKEN: 'chat-token', AGENDOR_CHAT_ACCOUNT_ID: '123' });
    const fetch = mockChat();
    const detail = await callTool('chat_get_conversation', { conversationId: 456 }, env, ['chat:read']);
    const messages = await callTool('chat_list_messages', { conversationId: 456 }, env, ['chat:read']);
    expect(detail.data.result.content[0].text).toContain('Cliente');
    expect(detail.data.result.content[0].text).not.toContain('phone_number');
    expect(messages.data.result.content[0].text).toContain('Texto da mensagem');
    expect(fetch.mock.calls.every(([request]) => (request as Request).method === 'GET')).toBe(true);
  });

  it('keeps all expanded reads behind chat scope and rejects caller attachment URLs', async () => {
    const env = testEnv({ AGENDOR_CHAT_TOKEN: 'synthetic-token', AGENDOR_CHAT_ACCOUNT_ID: '100' });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Synthetic fixture prohibits network'); });
    for (const [tool, input] of [
      ['chat_search_contacts', { query: 'SYNTHETIC' }], ['chat_get_contact', { contactId: 300 }],
      ['chat_list_contact_conversations', { contactId: 300 }], ['chat_list_attachments', { conversationId: 200 }],
      ['chat_get_attachment', { conversationId: 200, attachmentId: 400 }],
    ] as const) {
      const result = await callTool(tool, input, env, ['crm:read']);
      expect(result.data.result.isError).toBe(true);
      expect(JSON.parse(result.data.result.content[0].text).error.requiredScope).toBe('chat:read');
    }
    const rejected = await callTool('chat_get_attachment', { conversationId: 200, attachmentId: 400, url: 'https://example.invalid' }, env, ['chat:read']);
    expect(Boolean(rejected.data.error || rejected.data.result?.isError)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('forwards documented after through MCP and emits native attachment image content', async () => {
    const env = testEnv({ AGENDOR_CHAT_TOKEN: 'synthetic-token', AGENDOR_CHAT_ACCOUNT_ID: '100' });
    const handled: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async request => {
      const req = request as Request;
      const url = new URL(req.url);
      handled.push(url.pathname + url.search);
      if (url.pathname.endsWith('/messages')) return Response.json({ payload: [{ id: 11, conversation_id: 200, message_type: 0 }] });
      if (url.pathname.endsWith('/attachments')) return Response.json({ payload: [{ id: 400, data_url: 'https://chat.agendor.com.br/files/synthetic' }] });
      if (url.pathname === '/files/synthetic' && !req.headers.has('api_access_token')) return new Response('SYNTHETIC', { headers: { 'content-type': 'image/png' } });
      throw new Error('Unexpected synthetic request');
    });
    const messages = await callTool('chat_list_messages', { conversationId: 200, after: 10 }, env, ['chat:read']);
    expect(messages.data.result.isError).toBeUndefined();
    expect(JSON.parse(messages.data.result.content[0].text).coverage.missingReasons).toContain('history_start_not_reached');
    const attachment = await callTool('chat_get_attachment', { conversationId: 200, attachmentId: 400 }, env, ['chat:read']);
    expect(attachment.data.result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(handled).toEqual(['/api/v1/accounts/100/conversations/200/messages?after=10', '/api/v1/accounts/100/conversations/200/attachments', '/files/synthetic']);
  });
  it.each(['image', 'text', 'resource'] as const)('returns bounded binary parts for a large %s attachment', async format => {
    const env = testEnv({ AGENDOR_CHAT_TOKEN: 'synthetic-token', AGENDOR_CHAT_ACCOUNT_ID: '100' });
    const uri = 'https://chat.agendor.com.br/files/synthetic';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async request => {
      const req = request as Request;
      if (req.url.endsWith('/attachments')) return Response.json({ payload: [{ id: 400, data_url: uri }] });
      return new Response(format === 'image' ? new Uint8Array(400_000) : 'x'.repeat(550_000), { headers: { 'content-type': format === 'image' ? 'image/png' : format === 'text' ? 'text/plain' : 'application/pdf' } });
    });
    const { data } = await callTool('chat_get_attachment', { conversationId: 200, attachmentId: 400 }, env, ['chat:read']);
    expect(new TextEncoder().encode(JSON.stringify(data.result)).byteLength).toBeLessThan(524_288);
    expect(data.result.content).toHaveLength(2);
    expect(JSON.parse(data.result.content[0].text)).toMatchObject({conversationId:200,attachmentId:400,status:'available',offset:0,nextOffset:196608,contentComplete:false});
    expect(data.result.content[1].type).toBe('resource');
  });
  it('fails closed on the dedicated Chat rate limiter before upstream access', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const env = testEnv({ AGENDOR_CHAT_TOKEN: 'chat-token', AGENDOR_CHAT_ACCOUNT_ID: '123' });
    budgetMock(env).mockResolvedValue({ allowed: false, retryAt: Date.now() + 10_000 });
    const { data } = await callTool('chat_list_conversations', {}, env, ['chat:read']);
    expect(data.result.isError).toBe(true);
    expect(data.result.content[0].text).toContain('UPSTREAM_RATE_LIMITED');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('tolerates variable optional upstream fields while retaining stable conversation IDs', async () => {
    const env = testEnv({ AGENDOR_CHAT_TOKEN: 'chat-token', AGENDOR_CHAT_ACCOUNT_ID: '123' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: {
      meta: { all_count: 1 }, payload: [{ id: 456, inbox_id:4101,status: 2, meta: null, last_non_activity_message: { content: null } }],
    } }));
    const { data } = await callTool('chat_list_conversations', {}, env, ['chat:read']);
    expect(data.result.isError).toBeUndefined();
    expect(JSON.parse(data.result.content[0].text)).toMatchObject({ conversations: [{ id: 456 }], counts: { all_count: 1 }, coverage: { complete: false } });
  });
  it('does not expose upstream bodies on malformed responses or configuration errors', async () => {
    const env = testEnv({ AGENDOR_CHAT_TOKEN: 'chat-token', AGENDOR_CHAT_ACCOUNT_ID: '123' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: { payload: [{ id: 'not-numeric', secret: 'customer data' }] } }));
    const malformed = await callTool('chat_list_conversations', {}, env, ['chat:read']);
    expect(malformed.data.result.isError).toBe(true);
    expect(JSON.stringify(malformed.data)).not.toContain('customer data');
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockClear();
    const missing = await callTool('chat_list_conversations', {}, testEnv({ AGENDOR_CHAT_TOKEN: '', AGENDOR_CHAT_ACCOUNT_ID: '' }), ['chat:read']);
    expect(Boolean(missing.data.error || missing.data.result?.isError)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
