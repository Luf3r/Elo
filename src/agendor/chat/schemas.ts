import { z } from 'zod';

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const chatConversationIdInput = z.strictObject({ conversationId: positiveId });
export const chatConversationPageInput = z.strictObject({});
const conversationSchema = z.object({
  id: positiveId,
  status: z.unknown().optional(), inbox_name: z.unknown().optional(),
  created_at: z.unknown().optional(), timestamp: z.unknown().optional(),
  unread_count: z.unknown().optional(), meta: z.unknown().optional(),
  last_non_activity_message: z.unknown().optional(),
}).passthrough();
const messageSchema = z.object({
  id: positiveId, conversation_id: z.unknown().optional(), content: z.unknown().optional(),
  created_at: z.unknown().optional(), private: z.unknown().optional(),
  sender_type: z.unknown().optional(), sender: z.unknown().optional(),
}).passthrough();
export const conversationSchemaForDetail = conversationSchema.extend({ messages: z.array(messageSchema).max(100).optional() });
export const conversationsEnvelopeSchema = z.object({
  data: z.object({ meta: z.unknown().optional(), payload: z.array(conversationSchema).max(100) }).passthrough(),
}).passthrough();
export const conversationDetailSchema = conversationSchemaForDetail;
export const messagesEnvelopeSchema = z.object({
  meta: z.unknown().optional(), payload: z.array(messageSchema).max(100),
}).passthrough();

type Conversation = z.infer<typeof conversationSchema>;
type Message = z.infer<typeof messageSchema>;
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined; }
function finite(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function count(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function positive(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined; }

export function summarizeConversation(value: Conversation) {
  const sender = record(record(value.meta)?.sender);
  const latest = record(value.last_non_activity_message);
  const status = text(value.status);
  const inboxName = text(value.inbox_name);
  const createdAt = finite(value.created_at);
  const timestamp = finite(value.timestamp);
  const unreadCount = count(value.unread_count);
  const contactName = text(sender?.name);
  const crmPersonId = positive(sender?.agendor_person_id);
  const latestMessage = text(latest?.content);
  return {
    id: value.id,
    ...(status ? { status } : {}), ...(inboxName ? { inboxName } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(timestamp !== undefined ? { lastActivityAt: timestamp } : {}),
    ...(unreadCount !== undefined ? { unreadCount } : {}),
    ...(contactName ? { contactName } : {}),
    ...(crmPersonId !== undefined ? { crmPersonId } : {}),
    ...(latestMessage ? { latestMessage } : {}),
  };
}
export function summarizeMessage(value: Message) {
  const conversationId = positive(value.conversation_id);
  const content = text(value.content);
  const createdAt = finite(value.created_at);
  const senderType = text(value.sender_type);
  const senderName = text(record(value.sender)?.name);
  return {
    id: value.id,
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(content ? { content } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(typeof value.private === 'boolean' ? { private: value.private } : {}),
    ...(senderType ? { senderType } : {}), ...(senderName ? { senderName } : {}),
  };
}