import { z } from 'zod';
import type { ChatContact } from './types';

export const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const chatConversationIdInput = z.strictObject({ conversationId: positiveId });
export const chatConversationPageInput = z.strictObject({
  status: z.enum(['open', 'resolved', 'pending', 'snoozed', 'all']).optional(),
  assigneeTypeId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  assigneeType: z.enum(['all', 'me', 'unassigned']).optional(),
  page: positiveId.optional(),
  sortOrder: z.enum(['latest_first', 'oldest_first']).optional(),
});
export const chatMessageInput = z.strictObject({ conversationId: positiveId, after: positiveId.optional() });
export const chatContactInput = z.strictObject({ contactId: positiveId });
export const chatContactConversationsInput = chatContactInput.extend({ page: positiveId.optional() });
export const chatSearchContactsInput = z.strictObject({ query: z.string().trim().min(1).max(200) });
export const chatAttachmentListingInput = chatConversationIdInput.extend({ page: positiveId.optional() });
export const chatAttachmentInput = z
  .strictObject({
    conversationId: positiveId,
    attachmentId: positiveId,
    listingPage: positiveId.optional(),
    offset: z
      .number()
      .int()
      .nonnegative()
      .max(20 * 1048576)
      .optional(),
    expectedSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .refine((v) => !v.offset || !!v.expectedSha256, 'Continuation requires the previous content digest.');
export const conversationReadInput = z
  .strictObject({
    conversationId: positiveId,
    after: positiveId.optional(),
    continuation: z.strictObject({ conversationId: positiveId, after: positiveId }).optional(),
  })
  .refine(
    (v) => !(v.after && v.continuation) && (!v.continuation || v.continuation.conversationId === v.conversationId),
  );
export const contactSchema = z.object({ id: positiveId }).passthrough();
const conversationSchema = z
  .object({
    id: positiveId,
    inbox_id: z.unknown().optional(),
    status: z.unknown().optional(),
    inbox_name: z.unknown().optional(),
    created_at: z.unknown().optional(),
    timestamp: z.unknown().optional(),
    unread_count: z.unknown().optional(),
    meta: z.unknown().optional(),
    last_non_activity_message: z.unknown().optional(),
  })
  .passthrough();
const messageSchema = z
  .object({
    id: positiveId,
    conversation_id: z.unknown().optional(),
    content: z.unknown().optional(),
    created_at: z.unknown().optional(),
    private: z.unknown().optional(),
    sender_type: z.unknown().optional(),
    sender: z.unknown().optional(),
  })
  .passthrough();
export const conversationSchemaForDetail = conversationSchema.extend({
  messages: z.array(messageSchema).max(100).optional(),
});
export const conversationsEnvelopeSchema = z
  .object({
    data: z.object({ meta: z.unknown().optional(), payload: z.array(conversationSchema).max(100) }).passthrough(),
  })
  .passthrough();
export const conversationDetailSchema = conversationSchemaForDetail;
export const conversationScopeSchema = conversationSchema.pick({ id: true, inbox_id: true, meta: true }).strip();
export const messagesEnvelopeSchema = z
  .object({
    meta: z.unknown().optional(),
    payload: z.array(messageSchema).max(100),
  })
  .passthrough();
function collection<T extends z.ZodType>(item: T) {
  return z
    .union([
      z.object({ payload: z.array(item).max(10000) }),
      z.object({ data: z.object({ payload: z.array(item).max(100) }) }),
      z.object({ data: z.array(item).max(100) }),
    ])
    .transform((v) => ('payload' in v ? v.payload : Array.isArray(v.data) ? v.data : v.data.payload));
}
export const inboxEnvelopeSchema = z
  .union([
    z.object({ payload: z.array(z.object({ id: positiveId }).passthrough()).max(100) }).passthrough(),
    z
      .object({
        data: z.object({ payload: z.array(z.object({ id: positiveId }).passthrough()).max(100) }).passthrough(),
      })
      .passthrough(),
    z.object({ data: z.array(z.object({ id: positiveId }).passthrough()).max(100) }).passthrough(),
  ])
  .transform((value) =>
    'payload' in value ? value.payload : Array.isArray(value.data) ? value.data : value.data.payload,
  );
export const contactsEnvelopeSchema = collection(contactSchema);
export const contactDetailSchema = z
  .union([contactSchema, z.object({ payload: contactSchema }), z.object({ data: contactSchema })])
  .transform((v) =>
    'payload' in v
      ? (v.payload as z.infer<typeof contactSchema>)
      : 'data' in v
        ? (v.data as z.infer<typeof contactSchema>)
        : (v as z.infer<typeof contactSchema>),
  );
export const contactConversationsEnvelopeSchema = collection(conversationSchema);
export const attachmentsEnvelopeSchema = collection(z.object({ id: positiveId }).passthrough());
type Conversation = z.infer<typeof conversationSchema>;
type Message = z.infer<typeof messageSchema>;
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
export function summarizeContact(value: Record<string, unknown>): ChatContact | null {
  const id = positive(value.id);
  if (!id) return null;
  return {
    id,
    ...(text(value.name) ? { name: text(value.name) } : {}),
    ...(text(value.email) ? { email: text(value.email) } : {}),
    ...(text(value.phone_number) ? { phoneNumber: text(value.phone_number) } : {}),
    ...(positive(value.agendor_person_id) ? { crmPersonId: positive(value.agendor_person_id) } : {}),
  };
}
export function verifiedConversationInbox(value: { inbox_id?: unknown; meta?: unknown }): number | undefined {
  const meta = record(value.meta);
  const candidates = [value.inbox_id, meta?.inbox_id, record(meta?.inbox)?.id].filter((v) => v != null);
  const inbox = positive(candidates[0]);
  return inbox !== undefined && candidates.every((candidate) => candidate === inbox) ? inbox : undefined;
}
export function summarizeConversation(value: Conversation) {
  const sender = record(record(value.meta)?.sender);
  const latest = record(value.last_non_activity_message);
  const assignee = record(record(value.meta)?.assignee);
  const status = text(value.status);
  const inboxName = text(value.inbox_name);
  const meta = record(value.meta);
  const inboxId = positive(value.inbox_id) ?? positive(meta?.inbox_id) ?? positive(record(meta?.inbox)?.id);
  const createdAt = finite(value.created_at);
  const timestamp = finite(value.timestamp);
  const unreadCount = count(value.unread_count);
  const contactName = text(sender?.name);
  const crmPersonId = positive(sender?.agendor_person_id);
  const latestMessage = text(latest?.content);
  return {
    id: value.id,
    ...(status ? { status } : {}),
    ...(inboxName ? { inboxName } : {}),
    ...(inboxId !== undefined ? { inboxId } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(timestamp !== undefined ? { lastActivityAt: timestamp } : {}),
    ...(unreadCount !== undefined ? { unreadCount } : {}),
    ...(contactName ? { contactName } : {}),
    ...(positive(sender?.id) ? { contactId: positive(sender?.id) } : {}),
    ...(positive(assignee?.id) ? { assigneeId: positive(assignee?.id) } : {}),
    ...(text(assignee?.name) ? { assigneeName: text(assignee?.name) } : {}),
    ...(crmPersonId !== undefined ? { crmPersonId } : {}),
    ...(latestMessage ? { latestMessage } : {}),
  };
}
export function summarizeMessage(value: Message) {
  const conversationId = positive(value.conversation_id);
  const content = text(value.content);
  const createdAt = finite(value.created_at);
  const updatedAt = finite(value.updated_at);
  const sender = record(value.sender);
  const senderType = text(value.sender_type) ?? text(sender?.type);
  const senderName = text(sender?.name);
  const senderId = positive(sender?.id);
  // Explicit wire values only: a name or private flag never proves authorship/direction.
  const direction =
    value.message_type === 'incoming'
      ? ('incoming' as const)
      : value.message_type === 'outgoing'
        ? ('outgoing' as const)
        : value.message_type === 'activity'
          ? ('activity' as const)
          : ('unknown' as const);
  return {
    id: value.id,
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(content ? { content } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(typeof value.private === 'boolean' ? { private: value.private } : {}),
    ...(senderType ? { senderType } : {}),
    ...(senderName ? { senderName } : {}),
    ...(senderId ? { senderId } : {}),
    direction,
    ...(Array.isArray(value.attachments)
      ? {
          attachments: value.attachments.flatMap((a) =>
            record(a) && positive(record(a)!.id) ? [{ ...summarizeAttachment(record(a)!), messageId: value.id }] : [],
          ),
        }
      : {}),
    ...(typeof value.message_type === 'number' || typeof value.message_type === 'string'
      ? { messageType: value.message_type }
      : {}),
  };
}
export function summarizeAttachment(value: Record<string, unknown>) {
  return {
    id: positiveId.parse(value.id),
    ...(text(value.file_type) ? { fileType: text(value.file_type) } : {}),
    ...(text(value.content_type) ? { mimeType: text(value.content_type) } : {}),
    ...(count(value.file_size) !== undefined ? { byteSize: count(value.file_size) } : {}),
    ...(positive(value.message_id) ? { messageId: positive(value.message_id) } : {}),
  };
}
