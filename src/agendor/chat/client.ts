import { isInboxAllowed } from '../../automation/inbox-policy';
import { collectionPageInfo, readConversationBatch } from './pagination';
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
  chatConversationPageInput, contactDetailSchema,
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
  waitForBudget?: boolean;
}
export function createAgendorChatClient(env: Pick<Env, 'AGENDOR_CHAT_TOKEN' | 'AGENDOR_CHAT_ACCOUNT_ID'> & Partial<Pick<Env, 'AUTOMATION_STATE'>>, options: ChatClientOptions = {}) {
  if (!isConfiguredSecret(env.AGENDOR_CHAT_TOKEN) || !/^\d{1,20}$/.test(env.AGENDOR_CHAT_ACCOUNT_ID ?? '')) {
    throw new SafeError('CHAT_API_NOT_CONFIGURED', 'Chat service is not configured.', false, 503);
  }
  const budgetGate = options.budgetGate ?? createBudgetGate(env, 'chat');
  async function reserve(wait:boolean,signal?:AbortSignal) {
    for(let attempt=0;;attempt++) {
      try{await budgetGate();return;}catch(error){
        if(!wait || !(error instanceof SafeError) || error.code!=='UPSTREAM_RATE_LIMITED' || attempt>=3)throw error;
        let timer:ReturnType<typeof setTimeout>|undefined;
        try{await awaitChatRead(new Promise<void>(resolve=>{timer=setTimeout(resolve,10_000);}),signal ?? AbortSignal.timeout(35_000));}finally{clearTimeout(timer);}
      }
    }
  }
  async function get(path: string): Promise<unknown> {
    throwIfCancelled(options.signal);
    await reserve(options.waitForBudget===true,options.signal);
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
  async function rawAttachments(id:number,page?:number) {
    const {conversationId}=chatConversationIdInput.parse({conversationId:id});
    if(page!==undefined) chatConversationPageInput.parse({page});
    const path=`/accounts/${account}/conversations/${conversationId}/attachments`;
    const raw=await get(path+(page!==undefined?`?page=${page}`:''));
    const items=parse(attachmentsEnvelopeSchema,raw);
    if(items.some(a=>a.conversation_id!==undefined && a.conversation_id!==conversationId)) throw new SafeError('UPSTREAM_INVALID_RESPONSE','Chat returned inconsistent attachment identity.',false);
    return {items,pageInfo:collectionPageInfo(raw,page ?? 1,path)};
  }
  const client = {
    async listConversations(input: { status?: string; assigneeTypeId?: number; assigneeType?: string; sortOrder?: string; page?:number } = {}) {
      const filters = chatConversationPageInput.parse(input); const query = new URLSearchParams();
      if(filters.page!==undefined) query.set('page',String(filters.page));
      query.set('status',filters.status ?? 'all'); if (filters.assigneeTypeId !== undefined) query.set('assignee_type_id', String(filters.assigneeTypeId));
      if (filters.assigneeType) query.set('assignee_type', filters.assigneeType); if (filters.sortOrder) query.set('sort_order', filters.sortOrder);
      const suffix = query.toString() ? `?${query.toString()}` : '';
      const result = parse(conversationsEnvelopeSchema, await get(`/accounts/${account}/conversations${suffix}`));
      const rawMeta = result.data.meta;
      const meta = rawMeta !== null && typeof rawMeta === 'object' && !Array.isArray(rawMeta)
        ? rawMeta as Record<string, unknown> : {};
      const counts = Object.fromEntries(['mine_count', 'assigned_count', 'unassigned_count', 'all_count']
        .flatMap(key => {
          const value = meta[key];
          return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? [[key, value]] : [];
        }));
      const conversations=result.data.payload.map(summarizeConversation).filter(c=>isInboxAllowed(c.inboxId));
      const pageInfo=collectionPageInfo(result,filters.page ?? 1, `/accounts/${account}/conversations`);
      const coverage: Coverage = {complete:pageInfo.complete,missingReasons:pageInfo.complete?[]:['conversation_pagination_incomplete'],pagesRead:1,conversationsRead:conversations.length};
      return {conversations:[...new Map(conversations.map(c=>[c.id,c])).values()],counts,pageInfo,coverage};
    },
    async getConversation(id: number) {
      const { conversationId } = chatConversationIdInput.parse({ conversationId: id });
      const detail = parse(conversationDetailSchema, await get(`/accounts/${account}/conversations/${conversationId}`));
      const sender = record(record(detail.meta)?.sender);
      return { ...summarizeConversation(detail), contact: sender ? summarizeContact(sender) : null, coverage: partial('history_not_read') };
    },
    async listMessages(id: number, input: { after?: number } = {}): Promise<MessagePage> {
      const { conversationId, after = 1 } = chatMessageInput.parse({ conversationId: id, ...input });
      const result = parse(messagesEnvelopeSchema, await get(`/accounts/${account}/conversations/${conversationId}/messages${after ? `?after=${after}` : ''}`));
      const messages = result.payload.map(summarizeMessage);
      if (messages.some(message => message.conversationId !== undefined && message.conversationId !== conversationId)) throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Chat returned inconsistent message identity.', false);
      // Exclusive ascending after contract validated by the operator on conversations 42/203.
      let previous = after;
      for (const message of messages) {
        if (message.id <= previous) throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Chat message cursor did not advance.', false);
        previous = message.id;
      }
      const startReached = after === 1; const endReached = messages.length < 100;
      return { conversationId, messages, coverage: {
        complete: startReached && endReached, pagesRead: 1,
        missingReasons: [...(!startReached ? ['history_start_not_reached'] : []), ...(!endReached ? ['history_end_not_reached'] : [])],
        messagePagination: 'verified',messageHistory:startReached && endReached?'complete':'partial', history: { startReached, endReached, messagesRead: messages.length, pagesRead: 1, complete: startReached && endReached },
        editedMessageContent: { status: 'unavailable', reason: 'upstream_whatsapp_api_limitation' },
      }, ...(!endReached ? { continuation: { conversationId, after: previous } } : {}) };
    },
    async searchContacts(input: { query: string }) {
      const { query } = chatSearchContactsInput.parse(input);
      const normalized = query.toLocaleLowerCase('en-US');
      const selected = (await contacts()).filter(contact => [contact.name, contact.email, contact.phoneNumber].some(value => value?.toLocaleLowerCase('en-US').includes(normalized)));
      return { contacts: selected, coverage: partial('contact_search_partial', 'contact_pagination_unavailable') };
    },
    async getContact(id: number) {
      const { contactId } = chatContactInput.parse({ contactId: id });
      const value=parse(contactDetailSchema,await get(`/accounts/${account}/contacts/${contactId}`));
      if(value.id!==contactId) throw new SafeError('UPSTREAM_INVALID_RESPONSE','Chat returned inconsistent contact identity.',false);
      return {contact:summarizeContact(value),coverage:{complete:true,missingReasons:[],pagesRead:1}};
    },
    async listContactConversations(id: number, input: {page?:number} = {}) {
      const { contactId } = chatContactInput.parse({ contactId: id });
      const page=chatConversationPageInput.parse(input).page ?? 1;
      const path=`/accounts/${account}/contacts/${contactId}/conversations`;
      const raw=await get(path+(input.page!==undefined?`?page=${page}`:''));
      const values=parse(contactConversationsEnvelopeSchema,raw);
      const conversations=values.map(summarizeConversation).filter(c=>isInboxAllowed(c.inboxId));
      const pageInfo=collectionPageInfo(raw,page,path);
      const coverage: Coverage = {complete:pageInfo.complete,missingReasons:pageInfo.complete?[]:['conversation_pagination_incomplete'],pagesRead:1,conversationsRead:conversations.length};
      return {contactId,conversations:[...new Map(conversations.map(c=>[c.id,c])).values()],pageInfo,coverage};
    },
    async listAttachments(id: number,input:{page?:number}={}): Promise<AttachmentPage & {pageInfo:ReturnType<typeof collectionPageInfo>}> {
      const {items,pageInfo}=await rawAttachments(id,input.page);
      const attachments=[...new Map(items.map(a=>[a.id,summarizeAttachment(a)])).values()];
      return {attachments,pageInfo,coverage:{complete:pageInfo.complete,missingReasons:pageInfo.complete?[]:[pageInfo.hasNext===null?'attachment_pagination_unavailable':'attachment_pagination_incomplete'],pagesRead:1,attachmentCount:attachments.length}};
    },
    async readAttachment(input: AttachmentInput): Promise<AttachmentResult> {
      const parsed = chatAttachmentInput.parse(input);
      const listing=await rawAttachments(parsed.conversationId,parsed.listingPage);
      const attachment=listing.items.find(value=>value.id===parsed.attachmentId);
      if (!attachment) return { conversationId:parsed.conversationId,attachmentId:parsed.attachmentId,status:'unavailable',pending:true,reason:listing.pageInfo.endReached?'attachment_not_found':'attachment_listing_incomplete',nextListingPage:listing.pageInfo.nextPage };
      if (attachment.conversation_id !== undefined && attachment.conversation_id !== parsed.conversationId) return { ...parsed, status: 'unavailable', pending: true, reason: 'attachment_identity_mismatch' };
      return downloadAttachment(parsed, attachment.data_url, { request: async request => {
        await reserve(true,request.signal);
        throwIfCancelled(request.signal); return (options.request ?? fetch)(request);
      }, signal: options.signal, maxBytes: options.maxAttachmentBytes });
    },
  };
  return {...client,
    async listAttachments(id:number,input:{page?:number}={}):Promise<AttachmentPage> {
      const batch=await readConversationBatch(async page=>{const result=await client.listAttachments(id,{...input,...(page!==undefined?{page}:{})});return {...result,conversations:result.attachments};},input.page ?? 1);
      const {conversations,coverage,...rest}=batch;
      return {...rest,attachments:conversations,coverage:{complete:coverage.complete,pagesRead:coverage.pagesRead,attachmentCount:conversations.length,attachmentListing:coverage.complete?'complete':'partial',missingReasons:coverage.missingReasons.map(r=>r==='conversation_pagination_incomplete' && batch.pageInfo.hasNext===null?'attachment_pagination_unavailable':r.replace('conversation_','attachment_'))}};
    },
    async listConversations(input:Parameters<typeof client.listConversations>[0]={}) { return readConversationBatch(page=>client.listConversations({...input,...(page!==undefined?{page}:{})}),input.page ?? 1,{probeMissingPagination:true}); },
    async listContactConversations(id:number,input:{page?:number}={}) {return readConversationBatch(page=>client.listContactConversations(id,{...input,...(page!==undefined?{page}:{})}),input.page ?? 1,{probeMissingPagination:true});},
  };
}
export type AgendorChatClient = ReturnType<typeof createAgendorChatClient>;
