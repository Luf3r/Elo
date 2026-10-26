import { createBudgetGate, type BudgetGate } from '../../automation/state/budget';
import type { Env } from '../../env';
import { SafeError } from '../../errors';
import type { ErrorCode } from '../../errors';
import { isConfiguredSecret } from '../../auth';
import { throwIfCancelled } from '../../cancellation';
import {
  chatConversationIdInput, conversationDetailSchema, conversationsEnvelopeSchema,
  messagesEnvelopeSchema, summarizeConversation, summarizeMessage,
  chatMessageInput, chatContactInput, chatSearchContactsInput, chatAttachmentInput,
  contactsEnvelopeSchema, contactConversationsEnvelopeSchema, attachmentsEnvelopeSchema,
  summarizeContact, summarizeAttachment, record,
} from './schemas';

import { awaitChatRead, downloadAttachment } from './attachments';
import type { AttachmentInput, AttachmentResult, MessagePage, Coverage, AttachmentPage } from './types';
export { createConversationReader } from './contacts';

const CHAT_API_ORIGIN = 'https://chat.agendor.com.br/api/v1';
const CHAT_TIMEOUT_MS = 10_000;
const CHAT_MAX_RESPONSE_BYTES = 1_048_576;
export interface ChatClientOptions {
  budgetGate?: BudgetGate;
  signal?: AbortSignal;
  request?: (request: Request) => Promise<Response>;
  maxAttachmentBytes?: number;
}
export function createAgendorChatClient(env: Pick<Env, 'AGENDOR_CHAT_TOKEN' | 'AGENDOR_CHAT_ACCOUNT_ID'> & Partial<Pick<Env, 'AUTOMATION_STATE'>>, options: ChatClientOptions = {}) {
  if (!isConfiguredSecret(env.AGENDOR_CHAT_TOKEN) || !/^\d{1,20}$/.test(env.AGENDOR_CHAT_ACCOUNT_ID ?? '')) {
    throw new SafeError('CHAT_API_NOT_CONFIGURED', 'Chat service is not configured.', false, 503);
  }
  const budgetGate = options.budgetGate ?? createBudgetGate(env, 'chat');
  async function get(path: string): Promise<unknown> {
    throwIfCancelled(options.signal);
    await budgetGate();
    throwIfCancelled(options.signal);
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    try {
      const response = await awaitChatRead((options.request ?? fetch)(new Request(new URL(CHAT_API_ORIGIN + path), {
        method: 'GET', redirect: 'manual', signal,
        headers: { Accept: 'application/json', api_access_token: env.AGENDOR_CHAT_TOKEN! },
      })), signal);
      if (!response.ok) {
        if (response.body) await awaitChatRead(response.body.cancel(), signal);
        const errors: Record<number, [ErrorCode, string, boolean]> = {
          401: ['UPSTREAM_UNAUTHORIZED', 'Chat authentication failed.', false],
          403: ['UPSTREAM_FORBIDDEN', 'Chat access denied.', false],
          404: ['UPSTREAM_NOT_FOUND', 'Conversation not found.', false],
          429: ['UPSTREAM_RATE_LIMITED', 'Chat request limit reached. Retry later.', true],
        };
        const error = errors[response.status] ?? (response.status >= 500
          ? ['UPSTREAM_UNAVAILABLE', 'Chat service temporarily unavailable.', true] as const
          : ['UPSTREAM_INVALID_RESPONSE', 'Unexpected Chat response.', false] as const);
        throw new SafeError(error[0], error[1], error[2], response.status);
      }
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > CHAT_MAX_RESPONSE_BYTES) {
        if (response.body) await awaitChatRead(response.body.cancel(), signal);
        throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Chat response exceeded the size limit.', false);
      }
      if (!response.body) throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Chat returned an empty response.', false);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await awaitChatRead(reader.read(), signal);
          if (done) break;
          size += value.byteLength;
          if (size > CHAT_MAX_RESPONSE_BYTES) {
            await awaitChatRead(reader.cancel(), signal);
            throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Chat response exceeded the size limit.', false);
          }
          chunks.push(value);
        }
      } finally {
        if (signal.aborted) void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
      catch { throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Chat returned invalid JSON.', false); }
    } catch (error) {
      if (error instanceof SafeError) throw error;
      throwIfCancelled(options.signal);
      if (controller.signal.aborted) throw new SafeError('UPSTREAM_TIMEOUT', 'Chat request timed out.', true);
      throw new SafeError('UPSTREAM_UNAVAILABLE', 'Chat service temporarily unavailable.', true, 503);
    } finally { clearTimeout(timer); }
  }
  function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Chat returned an unexpected response format.', false);
    return result.data;
  }
  const account = env.AGENDOR_CHAT_ACCOUNT_ID;
  const partial = (...missingReasons: string[]): Coverage => ({ complete: false, missingReasons, pagesRead: 1 });
  async function contacts() {
    return parse(contactsEnvelopeSchema, await get(`/accounts/${account}/contacts`)).map(value => summarizeContact(value)!);
  }
  async function rawAttachments(id: number) {
    const { conversationId } = chatConversationIdInput.parse({ conversationId: id });
    return parse(attachmentsEnvelopeSchema, await get(`/accounts/${account}/conversations/${conversationId}/attachments`));
  }
  return {
    async listConversations() {
      const result = parse(conversationsEnvelopeSchema, await get(`/accounts/${account}/conversations`));
      const rawMeta = result.data.meta;
      const meta = rawMeta !== null && typeof rawMeta === 'object' && !Array.isArray(rawMeta)
        ? rawMeta as Record<string, unknown> : {};
      const counts = Object.fromEntries(['mine_count', 'assigned_count', 'unassigned_count', 'all_count']
        .flatMap(key => {
          const value = meta[key];
          return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? [[key, value]] : [];
        }));
      return { conversations: result.data.payload.map(summarizeConversation), counts, coverage: partial('conversation_discovery_unverified') };
    },
    async getConversation(id: number) {
      const { conversationId } = chatConversationIdInput.parse({ conversationId: id });
      const detail = parse(conversationDetailSchema, await get(`/accounts/${account}/conversations/${conversationId}`));
      const sender = record(record(detail.meta)?.sender);
      return { ...summarizeConversation(detail), contact: sender ? summarizeContact(sender) : null, coverage: partial('history_unverified') };
    },
    async listMessages(id: number, input: { after?: number } = {}): Promise<MessagePage> {
      const { conversationId, after } = chatMessageInput.parse({ conversationId: id, ...input });
      const result = parse(messagesEnvelopeSchema, await get(`/accounts/${account}/conversations/${conversationId}/messages${after ? `?after=${after}` : ''}`));
      const messages = result.payload.map(summarizeMessage);
      if (messages.some(message => message.conversationId !== undefined && message.conversationId !== conversationId)) throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Chat returned inconsistent message identity.', false);
      // Response metadata is not a verified cursor contract. Never invent a next page.
      return { conversationId, messages, coverage: partial('history_unverified', 'continuation_unverified', ...(after ? ['older_edits_not_covered'] : [])) };
    },
    async searchContacts(input: { query: string }) {
      const { query } = chatSearchContactsInput.parse(input);
      const normalized = query.toLocaleLowerCase('en-US');
      const selected = (await contacts()).filter(contact => [contact.name, contact.email, contact.phoneNumber].some(value => value?.toLocaleLowerCase('en-US').includes(normalized)));
      return { contacts: selected, coverage: partial('contact_search_partial', 'continuation_unverified') };
    },
    async getContact(id: number) {
      const { contactId } = chatContactInput.parse({ contactId: id });
      // Only the collection route has documented evidence; absence is not proof of nonexistence.
      return { contact: (await contacts()).find(contact => contact.id === contactId) ?? null, coverage: partial('contact_collection_partial') };
    },
    async listContactConversations(id: number) {
      const { contactId } = chatContactInput.parse({ contactId: id });
      const values = parse(contactConversationsEnvelopeSchema, await get(`/accounts/${account}/contacts/${contactId}/conversations`));
      return { contactId, conversations: values.map(summarizeConversation), coverage: partial('conversation_discovery_unverified', 'continuation_unverified') };
    },
    async listAttachments(id: number): Promise<AttachmentPage> {
      return { attachments: (await rawAttachments(id)).map(summarizeAttachment), coverage: partial('attachments_unverified', 'continuation_unverified') };
    },
    async readAttachment(input: AttachmentInput): Promise<AttachmentResult> {
      const parsed = chatAttachmentInput.parse(input);
      const attachment = (await rawAttachments(parsed.conversationId)).find(value => value.id === parsed.attachmentId);
      if (!attachment) return { ...parsed, status: 'unavailable', pending: true, reason: 'attachment_not_found' };
      if (attachment.conversation_id !== undefined && attachment.conversation_id !== parsed.conversationId) return { ...parsed, status: 'unavailable', pending: true, reason: 'attachment_identity_mismatch' };
      return downloadAttachment(parsed, attachment.data_url, { request: async request => { await budgetGate(); throwIfCancelled(options.signal); return (options.request ?? fetch)(request); }, signal: options.signal, maxBytes: options.maxAttachmentBytes });
    },
  };
}
export type AgendorChatClient = ReturnType<typeof createAgendorChatClient>;
