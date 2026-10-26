import type { Env } from '../../env';
import { SafeError } from '../../errors';
import type { ErrorCode } from '../../errors';
import { isConfiguredSecret } from '../../auth';
import { throwIfCancelled } from '../../cancellation';
import {
  chatConversationIdInput, conversationDetailSchema, conversationsEnvelopeSchema,
  messagesEnvelopeSchema, summarizeConversation, summarizeMessage,
} from './schemas';

const CHAT_API_ORIGIN = 'https://chat.agendor.com.br/api/v1';
const CHAT_TIMEOUT_MS = 10_000;
const CHAT_MAX_RESPONSE_BYTES = 1_048_576;
export interface AgendorChatClient {
  listConversations(): Promise<unknown>;
  getConversation(id: number): Promise<unknown>;
  listMessages(id: number): Promise<unknown>;
}
export function createAgendorChatClient(env: Pick<Env, 'AGENDOR_CHAT_TOKEN' | 'AGENDOR_CHAT_ACCOUNT_ID'>, options: { signal?: AbortSignal } = {}): AgendorChatClient {
  if (!isConfiguredSecret(env.AGENDOR_CHAT_TOKEN) || !/^\d{1,20}$/.test(env.AGENDOR_CHAT_ACCOUNT_ID ?? '')) {
    throw new SafeError('CHAT_API_NOT_CONFIGURED', 'Chat service is not configured.', false, 503);
  }
  async function get(path: string): Promise<unknown> {
    throwIfCancelled(options.signal);
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    try {
      const response = await fetch(new Request(new URL(CHAT_API_ORIGIN + path), {
        method: 'GET', redirect: 'manual', signal,
        headers: { Accept: 'application/json', api_access_token: env.AGENDOR_CHAT_TOKEN! },
      }));
      if (!response.ok) {
        await response.body?.cancel();
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
        await response.body?.cancel();
        throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Chat response exceeded the size limit.', false);
      }
      if (!response.body) throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Chat returned an empty response.', false);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > CHAT_MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Chat response exceeded the size limit.', false);
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
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
      return { conversations: result.data.payload.slice(0, 25).map(summarizeConversation), counts };
    },
    async getConversation(id) {
      const { conversationId } = chatConversationIdInput.parse({ conversationId: id });
      return summarizeConversation(parse(conversationDetailSchema, await get(`/accounts/${account}/conversations/${conversationId}`)));
    },
    async listMessages(id) {
      const { conversationId } = chatConversationIdInput.parse({ conversationId: id });
      const result = parse(messagesEnvelopeSchema, await get(`/accounts/${account}/conversations/${conversationId}/messages`));
      return { conversationId, messages: result.payload.slice(0, 20).map(summarizeMessage) };
    },
  };
}