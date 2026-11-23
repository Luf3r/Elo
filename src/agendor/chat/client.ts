import { collectionPageInfo, readConversationBatch } from './pagination';
import type { BudgetGate, InboxGuard } from '../ports';
import type { Env } from '../../env';
import { SafeError } from '../../shared/errors';
import { isChatConfigured } from '../../app/config/integrations';
import { throwIfCancelled } from '../../shared/cancellation';
import { createChatTransport } from './transport';
import {
  chatConversationIdInput,
  conversationDetailSchema,
  conversationScopeSchema,
  verifiedConversationInbox,
  conversationsEnvelopeSchema,
  messagesEnvelopeSchema,
  inboxEnvelopeSchema,
  summarizeConversation,
  summarizeMessage,
  chatMessageInput,
  chatContactInput,
  chatSearchContactsInput,
  chatAttachmentInput,
  chatConversationPageInput,
  contactDetailSchema,
  contactsEnvelopeSchema,
  contactConversationsEnvelopeSchema,
  attachmentsEnvelopeSchema,
  summarizeContact,
  summarizeAttachment,
  record,
} from './schemas';

import { downloadAttachment } from './attachments';
import type { AttachmentInput, AttachmentResult, MessagePage, Coverage, AttachmentPage } from './types';
export { createConversationReader } from './contacts';

export interface ChatClientOptions {
  budgetGate: BudgetGate;
  inboxGuard: InboxGuard;
  signal?: AbortSignal;
  request?: (request: Request) => Promise<Response>;
  maxAttachmentBytes?: number;
  waitForBudget?: boolean;
}
export { isChatConfigured } from '../../app/config/integrations';

export function createAgendorChatClient(
  env: Pick<Env, 'AGENDOR_CHAT_TOKEN' | 'AGENDOR_CHAT_ACCOUNT_ID'>,
  options: ChatClientOptions,
) {
  if (!isChatConfigured(env)) {
    throw new SafeError('CHAT_API_NOT_CONFIGURED', 'Chat service is not configured.', false, 503);
  }
  const token = env.AGENDOR_CHAT_TOKEN ?? '';
  const account = env.AGENDOR_CHAT_ACCOUNT_ID ?? '';
  const { inboxGuard } = options;
  const { reserve, get } = createChatTransport({
    token,
    budgetGate: options.budgetGate,
    signal: options.signal,
    request: options.request,
    waitForBudget: options.waitForBudget,
  });
  function parse<T>(
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    value: unknown,
  ): T {
    const result = schema.safeParse(value);
    if (!result.success)
      throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Chat returned an unexpected response format.', false);
    return result.data;
  }
  const partial = (...missingReasons: string[]): Coverage => ({ complete: false, missingReasons, pagesRead: 1 });
  async function contacts() {
    return parse(contactsEnvelopeSchema, await get(`/accounts/${account}/contacts`)).map((value) =>
      summarizeContact(value)!,
    );
  }
  async function rawAttachments(id: number, page?: number) {
    const { conversationId } = chatConversationIdInput.parse({ conversationId: id });
    if (page !== undefined) chatConversationPageInput.parse({ page });
    const path = `/accounts/${account}/conversations/${conversationId}/attachments`;
    const raw = await get(path + (page !== undefined ? `?page=${page}` : ''));
    const items = parse(attachmentsEnvelopeSchema, raw);
    if (items.some((a) => a.conversation_id !== undefined && a.conversation_id !== conversationId))
      throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Chat returned inconsistent attachment identity.', false);
    return { items, pageInfo: collectionPageInfo(raw, page ?? 1, path) };
  }
  const client = {
    /** Caller must establish the scoped transport contract before using this route. */
    async listInboxInventory() {
      const path = `/accounts/${account}/inboxes`;
      const raw = await get(path);
      const parsedRows = inboxEnvelopeSchema.safeParse(raw);
      if (!parsedRows.success)
        throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Chat returned an unexpected inbox inventory.', false);
      const rows: Array<{ id: number }> = parsedRows.data as Array<{ id: number }>;
      const root = record(raw);
      const links = record(root?.links) ?? record(record(root?.data)?.links);
      const paginationVerified = links ? Object.hasOwn(links, 'next') && links.next === null : rows.length < 100;
      if (!paginationVerified || new Set(rows.map((row) => row.id)).size !== rows.length)
        throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Chat inbox inventory is incomplete or inconsistent.', false);
      return rows.map((row) => row.id).sort((a, b) => a - b);
    },
    async listScopedActivity(inboxId: number, page: number) {
      if (!inboxGuard.isAllowed(inboxId))
        throw new SafeError('POLICY_BLOCKED', 'Conversation inbox is not authorized.', false, 403);
      chatConversationPageInput.parse({ page });
      const path = `/accounts/${account}/conversations`;
      const query = new URLSearchParams({
        inbox_id: String(inboxId),
        status: 'all',
        sort_order: 'latest_first',
        page: String(page),
      });
      const raw = await get(`${path}?${query.toString()}`);
      const rows = parse(conversationsEnvelopeSchema, raw).data.payload;
      if (
        rows.some((row) => verifiedConversationInbox(row) !== inboxId) ||
        new Set(rows.map((row) => row.id)).size !== rows.length
      ) {
        throw new SafeError(
          'UPSTREAM_INVALID_RESPONSE',
          'Chat did not prove a single authorized inbox for the entire page.',
          false,
        );
      }
      return {
        rows: rows.map((row) => {
          const timestamp =
            typeof row.timestamp === 'number' && Number.isSafeInteger(row.timestamp) && row.timestamp > 0
              ? row.timestamp
              : null;
          const status =
            typeof row.status === 'string' && ['open', 'resolved', 'pending', 'snoozed'].includes(row.status)
              ? row.status
              : null;
          const contact = chatContactInput.safeParse({ contactId: record(record(row.meta)?.sender)?.id });
          return {
            id: row.id,
            inboxId,
            timestamp,
            status,
            contact: contact.success ? { id: contact.data.contactId } : null,
          };
        }),
        pageInfo: collectionPageInfo(raw, page, path),
      };
    },
    async listConversations(
      input: {
        status?: string;
        assigneeTypeId?: number;
        assigneeType?: string;
        sortOrder?: string;
        page?: number;
      } = {},
    ) {
      const filters = chatConversationPageInput.parse(input);
      const query = new URLSearchParams();
      if (filters.page !== undefined) query.set('page', String(filters.page));
      query.set('status', filters.status ?? 'all');
      if (filters.assigneeTypeId !== undefined) query.set('assignee_type_id', String(filters.assigneeTypeId));
      if (filters.assigneeType) query.set('assignee_type', filters.assigneeType);
      if (filters.sortOrder) query.set('sort_order', filters.sortOrder);
      const suffix = query.toString() ? `?${query.toString()}` : '';
      const result = parse(conversationsEnvelopeSchema, await get(`/accounts/${account}/conversations${suffix}`));
      const rawMeta = result.data.meta;
      const meta =
        rawMeta !== null && typeof rawMeta === 'object' && !Array.isArray(rawMeta)
          ? (rawMeta as Record<string, unknown>)
          : {};
      const counts = Object.fromEntries(
        ['mine_count', 'assigned_count', 'unassigned_count', 'all_count'].flatMap((key) => {
          const value = meta[key];
          return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? [[key, value]] : [];
        }),
      );
      const conversations = result.data.payload
        .map(summarizeConversation)
        .filter((c) => inboxGuard.isAllowed(c.inboxId));
      const pageInfo = collectionPageInfo(result, filters.page ?? 1, `/accounts/${account}/conversations`);
      const coverage: Coverage = {
        complete: pageInfo.complete,
        missingReasons: pageInfo.complete ? [] : ['conversation_pagination_incomplete'],
        pagesRead: 1,
        conversationsRead: conversations.length,
      };
      return { conversations: [...new Map(conversations.map((c) => [c.id, c])).values()], counts, pageInfo, coverage };
    },
    async getConversation(id: number, options?: { scopeOnly: boolean }) {
      const { conversationId } = chatConversationIdInput.parse({ conversationId: id });
      const raw = await get('/accounts/' + account + '/conversations/' + conversationId);
      if (options?.scopeOnly) {
        const detail = parse(conversationScopeSchema, raw);
        const inboxId = verifiedConversationInbox(detail);
        const senderId = chatContactInput.safeParse({ contactId: record(record(detail.meta)?.sender)?.id });
        return {
          id: detail.id,
          ...(inboxId === undefined ? {} : { inboxId }),
          contact: senderId.success ? { id: senderId.data.contactId } : null,
        };
      }
      const detail = parse(conversationDetailSchema, raw);
      const sender = record(record(detail.meta)?.sender);
      return {
        ...summarizeConversation(detail),
        contact: sender ? summarizeContact(sender) : null,
        coverage: partial('history_not_read'),
      };
    },
    async listMessages(id: number, input: { after?: number } = {}): Promise<MessagePage> {
      const { conversationId, after = 1 } = chatMessageInput.parse({ conversationId: id, ...input });
      const result = parse(
        messagesEnvelopeSchema,
        await get(`/accounts/${account}/conversations/${conversationId}/messages${after ? `?after=${after}` : ''}`),
      );
      const messages = result.payload.map(summarizeMessage);
      if (messages.some((message) => message.conversationId !== undefined && message.conversationId !== conversationId))
        throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Chat returned inconsistent message identity.', false);
      // Exclusive ascending after contract validated by the operator on conversations 42/203.
      let previous = after;
      for (const message of messages) {
        if (message.id <= previous)
          throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Chat message cursor did not advance.', false);
        previous = message.id;
      }
      const startReached = after === 1;
      const endReached = messages.length < 100;
      return {
        conversationId,
        messages,
        coverage: {
          complete: startReached && endReached,
          pagesRead: 1,
          missingReasons: [
            ...(!startReached ? ['history_start_not_reached'] : []),
            ...(!endReached ? ['history_end_not_reached'] : []),
          ],
          messagePagination: 'verified',
          messageHistory: startReached && endReached ? 'complete' : 'partial',
          history: {
            startReached,
            endReached,
            messagesRead: messages.length,
            pagesRead: 1,
            complete: startReached && endReached,
          },
          editedMessageContent: { status: 'unavailable', reason: 'upstream_whatsapp_api_limitation' },
        },
        ...(!endReached ? { continuation: { conversationId, after: previous } } : {}),
      };
    },
    async searchContacts(input: { query: string }) {
      const { query } = chatSearchContactsInput.parse(input);
      const normalized = query.toLocaleLowerCase('en-US');
      const selected = (await contacts()).filter((contact) =>
        [contact.name, contact.email, contact.phoneNumber].some((value) =>
          value?.toLocaleLowerCase('en-US').includes(normalized),
        ),
      );
      return { contacts: selected, coverage: partial('contact_search_partial', 'contact_pagination_unavailable') };
    },
    async getContact(id: number) {
      const { contactId } = chatContactInput.parse({ contactId: id });
      const value = parse(contactDetailSchema, await get(`/accounts/${account}/contacts/${contactId}`));
      if (value.id !== contactId)
        throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Chat returned inconsistent contact identity.', false);
      return { contact: summarizeContact(value), coverage: { complete: true, missingReasons: [], pagesRead: 1 } };
    },
    async listContactConversations(id: number, input: { page?: number } = {}) {
      const { contactId } = chatContactInput.parse({ contactId: id });
      const page = chatConversationPageInput.parse(input).page ?? 1;
      const path = `/accounts/${account}/contacts/${contactId}/conversations`;
      const raw = await get(path + (input.page !== undefined ? `?page=${page}` : ''));
      const values = parse(contactConversationsEnvelopeSchema, raw);
      const conversations = values.map(summarizeConversation).filter((c) => inboxGuard.isAllowed(c.inboxId));
      const pageInfo = collectionPageInfo(raw, page, path);
      const coverage: Coverage = {
        complete: pageInfo.complete,
        missingReasons: pageInfo.complete ? [] : ['conversation_pagination_incomplete'],
        pagesRead: 1,
        conversationsRead: conversations.length,
      };
      return {
        contactId,
        conversations: [...new Map(conversations.map((c) => [c.id, c])).values()],
        pageInfo,
        coverage,
      };
    },
    async listAttachments(
      id: number,
      input: { page?: number } = {},
    ): Promise<AttachmentPage & { pageInfo: ReturnType<typeof collectionPageInfo> }> {
      const { items, pageInfo } = await rawAttachments(id, input.page);
      const attachments = [...new Map(items.map((a) => [a.id, summarizeAttachment(a)])).values()];
      return {
        attachments,
        pageInfo,
        coverage: {
          complete: pageInfo.complete,
          missingReasons: pageInfo.complete
            ? []
            : [pageInfo.hasNext === null ? 'attachment_pagination_unavailable' : 'attachment_pagination_incomplete'],
          pagesRead: 1,
          attachmentCount: attachments.length,
        },
      };
    },
    async readAttachment(input: AttachmentInput): Promise<AttachmentResult> {
      const parsed = chatAttachmentInput.parse(input);
      const listing = await rawAttachments(parsed.conversationId, parsed.listingPage);
      const attachment = listing.items.find((value) => value.id === parsed.attachmentId);
      if (!attachment)
        return {
          conversationId: parsed.conversationId,
          attachmentId: parsed.attachmentId,
          status: 'unavailable',
          pending: true,
          reason: listing.pageInfo.endReached ? 'attachment_not_found' : 'attachment_listing_incomplete',
          nextListingPage: listing.pageInfo.nextPage,
        };
      if (attachment.conversation_id !== undefined && attachment.conversation_id !== parsed.conversationId)
        return { ...parsed, status: 'unavailable', pending: true, reason: 'attachment_identity_mismatch' };
      return downloadAttachment(parsed, attachment.data_url, {
        request: async (request) => {
          await reserve(true, request.signal);
          throwIfCancelled(request.signal);
          return (options.request ?? fetch)(request);
        },
        signal: options.signal,
        maxBytes: options.maxAttachmentBytes,
      });
    },
  };
  return {
    ...client,
    async listAttachments(
      id: number,
      input: { page?: number; maxPages?: number; beforePage?(): Promise<void> } = {},
    ): Promise<AttachmentPage> {
      const batch = await readConversationBatch(
        async (page) => {
          await input.beforePage?.();
          const result = await client.listAttachments(id, { ...input, ...(page !== undefined ? { page } : {}) });
          return { ...result, conversations: result.attachments };
        },
        input.page ?? 1,
        { maxPages: input.maxPages },
      );
      const { conversations, coverage, ...rest } = batch;
      return {
        ...rest,
        attachments: conversations,
        coverage: {
          complete: coverage.complete,
          pagesRead: coverage.pagesRead,
          attachmentCount: conversations.length,
          attachmentListing: coverage.complete ? 'complete' : 'partial',
          missingReasons: coverage.missingReasons.map((r) =>
            r === 'conversation_pagination_incomplete' && batch.pageInfo.hasNext === null
              ? 'attachment_pagination_unavailable'
              : r.replace('conversation_', 'attachment_'),
          ),
        },
      };
    },
    async listConversations(input: Parameters<typeof client.listConversations>[0] = {}) {
      return readConversationBatch(
        (page) => client.listConversations({ ...input, ...(page !== undefined ? { page } : {}) }),
        input.page ?? 1,
        { probeMissingPagination: true },
      );
    },
    async listContactConversations(id: number, input: { page?: number } = {}) {
      return readConversationBatch(
        (page) => client.listContactConversations(id, { ...input, ...(page !== undefined ? { page } : {}) }),
        input.page ?? 1,
        { probeMissingPagination: true },
      );
    },
  };
}
export type AgendorChatClient = ReturnType<typeof createAgendorChatClient>;
