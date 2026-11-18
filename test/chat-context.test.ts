import { allowBudget } from './helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgendorChatClient } from '../src/agendor/chat/client';
import * as context from '../src/agendor/chat/client';

beforeEach(() =>
  vi.stubGlobal('fetch', () => {
    throw new Error('Network blocked by synthetic fixture');
  }),
);
afterEach(() => vi.unstubAllGlobals());
const env = { AGENDOR_CHAT_TOKEN: 'synthetic-token', AGENDOR_CHAT_ACCOUNT_ID: '100' };
const message = (id: number) => ({
  id,
  conversation_id: 200,
  content: 'SYNTHETIC',
  created_at: 1000,
  updated_at: 1001,
  message_type: 'incoming',
  sender: { id: 300, type: 'contact' },
});
function clientFor(handler: (url: URL) => unknown) {
  const request = async (request: Request) => {
    expect(request.method).toBe('GET');
    expect(new URL(request.url).origin).toBe('https://chat.agendor.com.br');
    return Response.json(handler(new URL(request.url)));
  };
  vi.stubGlobal('fetch', request);
  return createAgendorChatClient(env, { budgetGate: allowBudget, request });
}
describe('bounded Chat context', () => {
  it('isolates fixed-route reads entirely in the closed synthetic transport', async () => {
    const handled: number[] = [];
    const client = clientFor((url) => {
      if (url.pathname !== '/api/v1/accounts/100/conversations') throw new Error('Unexpected fixture request');
      const page = Number(url.searchParams.get('page') ?? 1);
      handled.push(page);
      return page === 1 ? { data: { payload: [{ id: 200, inbox_id: 4101 }] } } : { data: { payload: [] } };
    });
    const result = await client.listConversations();
    expect(result.conversations).toEqual([{ id: 200, inboxId: 4101 }]);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.paginationProbe).toMatchObject({ pagesScanned: 3, stoppedBy: 'page_limit' });
    expect(handled).toEqual([1, 2, 3]);
  });
  it('preserves more than twenty messages, direction, author and revision', async () => {
    const client = clientFor(() => ({ payload: Array.from({ length: 25 }, (_, i) => message(i + 2)) }));
    const result = await client.listMessages(200);
    expect(result.messages).toHaveLength(25);
    expect(result.messages[0]).toMatchObject({ id: 2, direction: 'incoming', senderId: 300, updatedAt: 1001 });
    expect(result.coverage.complete).toBe(true);
    expect(result.coverage.missingReasons).toEqual([]);
  });
  it('uses documented after and reports a missing history start for a delta', async () => {
    const client = clientFor((url) => {
      expect(url.pathname).toBe('/api/v1/accounts/100/conversations/200/messages');
      expect(url.search).toBe('?after=10');
      return { payload: [message(11)] };
    });
    const result = await client.listMessages(200, { after: 10 });
    expect(result.coverage.missingReasons).toContain('history_start_not_reached');
    expect(result.continuation).toBeUndefined();
  });
  it('selects contact attributes without leaking raw metadata and keeps multiple conversations', async () => {
    const client = clientFor((url) =>
      url.pathname.endsWith('/contacts/300')
        ? { payload: { id: 300, name: 'SYNTHETIC', email: 'synthetic@example.invalid' } }
        : url.pathname.endsWith('/contacts')
          ? {
              payload: [
                {
                  id: 300,
                  name: 'SYNTHETIC',
                  email: 'synthetic@example.invalid',
                  custom_attributes: { secret: 'omit' },
                },
              ],
            }
          : {
              payload: [
                { id: 200, inbox_id: 4101 },
                { id: 201, inbox_id: 4102 },
              ],
            },
    );
    expect((await client.getContact(300)).contact).toEqual({
      id: 300,
      name: 'SYNTHETIC',
      email: 'synthetic@example.invalid',
    });
    expect((await client.listContactConversations(300)).conversations.map((c) => c.id)).toEqual([200, 201]);
    expect((await client.searchContacts({ query: 'example.invalid' })).coverage.complete).toBe(false);
  });
  it('signals incomplete coverage when a cursor repeats', async () => {
    let pages = 0;
    const reader = context.createConversationReader({
      getConversation: async () => ({ id: 200, contact: null }),
      listAttachments: async () => ({
        attachments: [],
        coverage: { complete: false, missingReasons: ['attachments_unverified'], pagesRead: 1 },
      }),
      listMessages: async () => ({
        conversationId: 200,
        messages: [{ id: ++pages + 1 }],
        coverage: { complete: false, missingReasons: [], pagesRead: 1 },
        continuation: { conversationId: 200, after: 2 },
      }),
    });
    const result = await reader.readConversation({ conversationId: 200 });
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.missingReasons).toContain('cursor_repeated');
    expect(pages).toBe(2);
    expect(result.continuation).toBeUndefined();
  });
  it('bounds verified adapter batches at ten and requires explicit continuation', async () => {
    let pages = 0;
    const reader = context.createConversationReader({
      getConversation: async () => ({ id: 200, contact: null }),
      listAttachments: async () => ({
        attachments: [],
        coverage: { complete: true, missingReasons: [], pagesRead: 1 },
      }),
      listMessages: async () => {
        const page = ++pages;
        return {
          conversationId: 200,
          messages: Array.from({ length: 20 }, (_, i) => ({ id: (page - 1) * 20 + i + 2 })),
          coverage: { complete: false, missingReasons: [], pagesRead: 1 },
          continuation: { conversationId: 200, after: page * 20 + 1 },
        };
      },
    });
    const result = await reader.readConversation({ conversationId: 200 });
    expect(result.messages).toHaveLength(200);
    expect(pages).toBe(10);
    expect(result.continuation).toEqual({ conversationId: 200, after: 201 });
    expect(result.coverage.missingReasons).toContain('history_read_limit');
  });
  it('changes snapshot revision for an older edited message and keeps unknown authors unknown', async () => {
    let updatedAt = 1001;
    const reader = context.createConversationReader({
      getConversation: async () => ({ id: 200, contact: null }),
      listAttachments: async () => ({
        attachments: [],
        coverage: { complete: false, missingReasons: ['attachments_unverified'], pagesRead: 1 },
      }),
      listMessages: async () => ({
        conversationId: 200,
        messages: [{ id: 2, updatedAt }],
        coverage: { complete: false, missingReasons: ['history_unverified'], pagesRead: 1 },
      }),
    });
    const first = await reader.readConversation({ conversationId: 200 });
    updatedAt++;
    const second = await reader.readConversation({ conversationId: 200 });
    expect(first.revision).not.toBe(second.revision);
    const client = clientFor(() => ({ payload: [{ id: 2, message_type: 'unexpected', sender: {} }] }));
    expect((await client.listMessages(200)).messages[0]?.direction).toBe('unknown');
  });
  it('leaves unverified numeric message direction unknown and rejects inconsistent conversation identity', async () => {
    const client = clientFor(() => ({ payload: [{ id: 2, message_type: 0 }] }));
    expect((await client.listMessages(200)).messages[0]).toMatchObject({ direction: 'unknown', messageType: 0 });
    const other = clientFor(() => ({ payload: [{ id: 1, conversation_id: 201 }] }));
    await expect(other.listMessages(200)).rejects.toMatchObject({ code: 'UPSTREAM_INVALID_RESPONSE' });
  });
  it('returns missing coverage if an attachment list is unavailable without exposing upstream errors', async () => {
    const reader = context.createConversationReader({
      getConversation: async () => ({ id: 200, contact: { id: 300 } }),
      listAttachments: async () => {
        throw new Error('SYNTHETIC secret');
      },
      listMessages: async () => ({
        conversationId: 200,
        messages: [],
        coverage: { complete: false, missingReasons: ['history_unverified'], pagesRead: 1 },
      }),
    });
    const result = await reader.readConversation({ conversationId: 200 });
    expect(result.coverage.missingReasons).toContain('attachment_listing_query_failed');
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('rejects cross-conversation continuation before invoking dependencies', async () => {
    const unexpected = async (): Promise<never> => {
      throw new Error('Unexpected dependency call');
    };
    const reader = context.createConversationReader({
      getConversation: unexpected,
      listAttachments: unexpected,
      listMessages: unexpected,
    });
    await expect(
      reader.readConversation({ conversationId: 200, continuation: { conversationId: 201, after: 10 } }),
    ).rejects.toBeDefined();
  });
});
