import { conversationReadInput } from './schemas';
import type { AttachmentPage, ChatContact, ChatMessage, ConversationReadInput, ConversationSnapshot, MessagePage } from './types';

export interface ConversationReaderDependencies {
  getConversation(id: number): Promise<{ id: number; inboxId?: number; contact?: ChatContact | null }>;
  listMessages(id: number, input?: { after?: number }): Promise<MessagePage>;
  listAttachments(id: number): Promise<AttachmentPage>;
}
/** Pagination is driven only by the injected adapter's verified continuations. */
export function createConversationReader(deps: ConversationReaderDependencies) {
  return { async readConversation(input: ConversationReadInput): Promise<ConversationSnapshot> {
    const parsed = conversationReadInput.parse(input);
    const conversation = await deps.getConversation(parsed.conversationId);
    const reasons = new Set<string>();
    if (conversation.id !== parsed.conversationId) throw new Error('Conversation identity mismatch.');
    const contact = conversation.contact ?? null;
    if (!contact) reasons.add('contact_unavailable');
    let attachments: AttachmentPage = { attachments: [], coverage: { complete: false, missingReasons: ['attachments_unavailable'], pagesRead: 0 } };
    try { attachments = await deps.listAttachments(parsed.conversationId); } catch { /* No upstream details escape. */ }
    for (const reason of attachments.coverage.missingReasons) reasons.add(reason);
    if (!attachments.coverage.complete && !attachments.coverage.missingReasons.length) reasons.add('attachments_incomplete');
    const messages = new Map<number, ChatMessage>();
    const seen = new Set<number>();
    let after = parsed.continuation?.after ?? parsed.after;
    if (after) { seen.add(after); reasons.add('older_edits_not_covered'); }
    let pagesRead = 0;
    let readCount = 0;
    let continuation: MessagePage['continuation'];
    let complete = false;
    while (pagesRead < 5 && readCount < 100) {
      const page = await deps.listMessages(parsed.conversationId, after ? { after } : undefined);
      pagesRead++;
      if (page.conversationId !== parsed.conversationId) { reasons.add('conversation_mismatch'); break; }
      for (const reason of page.coverage.missingReasons) reasons.add(reason);
      const remaining = 100 - readCount;
      for (const message of page.messages.slice(0, remaining)) {
        if (message.conversationId !== undefined && message.conversationId !== parsed.conversationId) { reasons.add('message_conversation_mismatch'); continue; }
        const prior = messages.get(message.id);
        if (!prior || (message.updatedAt ?? 0) >= (prior.updatedAt ?? 0)) messages.set(message.id, message);
      }
      readCount += Math.min(page.messages.length, remaining);
      if (page.messages.length > remaining) { reasons.add('read_limit'); break; }
      const next = page.continuation;
      if (!next) {
        complete = page.coverage.complete;
        if (!complete && !page.coverage.missingReasons.length) reasons.add('history_incomplete');
        break;
      }
      if (next.conversationId !== parsed.conversationId || !Number.isSafeInteger(next.after) || next.after <= 0) { reasons.add('cursor_invalid'); break; }
      if (seen.has(next.after)) { reasons.add('cursor_repeated'); break; }
      seen.add(next.after);
      if (readCount >= 100 || pagesRead >= 5) { continuation = next; reasons.add('read_limit'); break; }
      after = next.after;
    }
    const selectedMessages = [...messages.values()].sort((a, b) => a.id - b.id);
    const selectedAttachments = [...attachments.attachments].sort((a, b) => a.id - b.id);
    const bytes = new TextEncoder().encode(JSON.stringify({ conversationId: parsed.conversationId, inboxId: conversation.inboxId, contact, messages: selectedMessages, attachments: selectedAttachments }));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const revision = [...new Uint8Array(hash)].map(v => v.toString(16).padStart(2, '0')).join('');
    return {
      conversationId: parsed.conversationId, ...(conversation.inboxId !== undefined ? { inboxId: conversation.inboxId } : {}), revision, contact, messages: selectedMessages, attachments: selectedAttachments,
      coverage: { complete: complete && attachments.coverage.complete && reasons.size === 0, missingReasons: [...reasons], pagesRead },
      ...(continuation ? { continuation } : {}),
    };
  } };
}
