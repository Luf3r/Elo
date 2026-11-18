import { conversationReadInput } from './schemas';
import { SafeError } from '../../shared/errors';
import type {
  AttachmentPage,
  ChatContact,
  ChatMessage,
  ConversationReadInput,
  ConversationSnapshot,
  MessagePage,
} from './types';

export interface ConversationReaderDependencies {
  getConversation(id: number): Promise<{ id: number; inboxId?: number; contact?: ChatContact | null }>;
  listMessages(id: number, input?: { after?: number }): Promise<MessagePage>;
  listAttachments(id: number, input?: { page?: number; maxPages?: number }): Promise<AttachmentPage>;
  validateConversation?(conversation: { id: number; inboxId?: number }): void;
}
export interface ReadProgress {
  previous?: ConversationSnapshot;
  onProgress?(snapshot: ConversationSnapshot): Promise<void>;
  maxMessagePages?: number;
  maxAttachmentPages?: number;
}
/** Every completed batch is resumable; a rate limit never discards a successful page. */
export function createConversationReader(deps: ConversationReaderDependencies) {
  return {
    async readConversation(input: ConversationReadInput, progress: ReadProgress = {}): Promise<ConversationSnapshot> {
      const parsed = conversationReadInput.parse(input);
      const conversation = await deps.getConversation(parsed.conversationId);
      if (conversation.id !== parsed.conversationId) throw new Error('Conversation identity mismatch.');
      deps.validateConversation?.(conversation);
      const prior = progress.previous;
      if (prior && prior.conversationId !== conversation.id) throw Error('Conversation progress mismatch.');
      const contact = conversation.contact ?? null;
      const reasons = new Set<string>();
      if (!contact) reasons.add('contact_unavailable');
      if (prior?.coverage.missingReasons.includes('attachment_collection_missing_media'))
        reasons.add('attachment_collection_missing_media');
      let attachments: AttachmentPage = {
        attachments: [],
        coverage: { complete: false, missingReasons: ['attachment_listing_query_failed'], pagesRead: 0 },
      };
      // Reuse metadata already persisted during this traversal; refresh on a new preparation.
      let attachmentListing = prior?.attachmentListing;
      if (prior)
        attachments = {
          attachments: prior.attachments,
          coverage: {
            complete:
              attachmentListing?.complete ?? !prior.coverage.missingReasons.some((r) => r.startsWith('attachment')),
            missingReasons:
              attachmentListing?.missingReasons ??
              prior.coverage.missingReasons.filter((r) => r.startsWith('attachment')),
            pagesRead: attachmentListing?.pagesRead ?? 0,
          },
        };
      const attachmentPagesRemaining = (progress.maxAttachmentPages ?? Infinity) - (attachmentListing?.pagesRead ?? 0);
      if ((!prior || attachmentListing?.nextPage) && attachmentPagesRemaining > 0) {
        try {
          const options = {
            ...(attachmentListing?.nextPage ? { page: attachmentListing.nextPage } : {}),
            ...(attachmentPagesRemaining < 3 ? { maxPages: attachmentPagesRemaining } : {}),
          };
          const page = await deps.listAttachments(
            parsed.conversationId,
            Object.keys(options).length ? options : undefined,
          );
          const values = new Map([...attachments.attachments, ...page.attachments].map((a) => [a.id, a]));
          const complete =
            page.coverage.complete || (attachmentListing !== undefined && page.pageInfo?.endReached === true);
          attachmentListing = {
            complete,
            pagesRead: (attachmentListing?.pagesRead ?? 0) + page.coverage.pagesRead,
            nextPage: page.pageInfo?.nextPage ?? null,
            endReached: page.pageInfo?.endReached ?? complete,
            missingReasons: complete ? [] : page.coverage.missingReasons,
            source: 'attachment_endpoint',
            messagePagesRead: attachmentListing?.messagePagesRead ?? 0,
          };
          attachments = {
            attachments: [...values.values()],
            coverage: {
              complete,
              missingReasons: attachmentListing.missingReasons,
              pagesRead: attachmentListing.pagesRead,
            },
          };
        } catch (error) {
          if (error instanceof SafeError && (error.retryable || error.code === 'MCP_UNAUTHORIZED')) throw error;
        }
      }
      if (
        progress.maxAttachmentPages !== undefined &&
        (!attachmentListing || attachmentListing.nextPage) &&
        (attachmentListing?.pagesRead ?? 0) >= progress.maxAttachmentPages
      ) {
        attachmentListing = {
          complete: false,
          pagesRead: attachmentListing?.pagesRead ?? 0,
          nextPage: null,
          endReached: false,
          missingReasons: ['attachment_page_limit'],
        };
        attachments.coverage = {
          complete: false,
          pagesRead: attachmentListing.pagesRead,
          missingReasons: attachmentListing.missingReasons,
        };
      }
      attachments.coverage.missingReasons.forEach((r) => reasons.add(r));
      if (!attachments.coverage.complete && !attachments.coverage.missingReasons.length)
        reasons.add('attachment_listing_incomplete');
      const messages = new Map<number, ChatMessage>((prior?.messages ?? []).map((m) => [m.id, m]));
      let after = prior?.continuation?.after ?? parsed.continuation?.after ?? parsed.after ?? 1;
      const seen = new Set<number>([after]);
      const startReached = prior?.coverage.history?.startReached ?? after === 1;
      let pagesRead = prior?.coverage.history?.pagesRead ?? 0;
      let endReached = prior?.coverage.history?.endReached ?? false;
      let continuation: MessagePage['continuation'] = { conversationId: conversation.id, after };
      const finish = async (): Promise<ConversationSnapshot> => {
        const selectedMessages = [...messages.values()].sort((a, b) => a.id - b.id);
        const listed = new Map(attachments.attachments.map((a) => [a.id, a]));
        for (const m of selectedMessages)
          for (const a of m.attachments ?? []) {
            if (!listed.has(a.id)) {
              listed.set(a.id, a);
              reasons.add('attachment_collection_missing_media');
            }
          }
        const selectedAttachments = [...listed.values()].sort((a, b) => a.id - b.id);
        const attachmentEndpointComplete = attachmentListing?.complete ?? attachments.coverage.complete;
        const confirmedMediaDiscrepancy =
          attachmentEndpointComplete && reasons.has('attachment_collection_missing_media');
        if (startReached && endReached && !confirmedMediaDiscrepancy && !reasons.has('attachment_page_limit')) {
          const recoverableReasons = new Set([
            'attachment_pagination_unavailable',
            'attachment_pagination_incomplete',
            'attachment_listing_incomplete',
            'attachment_listing_query_failed',
            'attachment_collection_missing_media',
          ]);
          for (const reason of recoverableReasons) reasons.delete(reason);
          attachmentListing = {
            complete: true,
            pagesRead: attachmentListing?.pagesRead ?? 0,
            nextPage: null,
            endReached: attachmentListing?.endReached ?? false,
            missingReasons: [],
            source: attachmentEndpointComplete ? 'combined' : 'message_history',
            messagePagesRead: pagesRead,
          };
        }
        const missingReasons = [
          ...reasons,
          ...(!startReached ? ['history_start_not_reached'] : []),
          ...(!endReached ? ['history_end_not_reached'] : []),
        ];
        const bytes = new TextEncoder().encode(
          JSON.stringify({
            conversationId: conversation.id,
            inboxId: conversation.inboxId,
            contact,
            messages: selectedMessages,
            attachments: selectedAttachments,
          }),
        );
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        const snapshot: ConversationSnapshot = {
          conversationId: conversation.id,
          ...(conversation.inboxId !== undefined ? { inboxId: conversation.inboxId } : {}),
          contact,
          messages: selectedMessages,
          attachments: selectedAttachments,
          ...(attachmentListing ? { attachmentListing } : {}),
          revision: [...new Uint8Array(hash)].map((v) => v.toString(16).padStart(2, '0')).join(''),
          coverage: {
            complete:
              startReached &&
              endReached &&
              missingReasons.length === 0 &&
              (attachmentListing?.complete ?? attachments.coverage.complete),
            missingReasons,
            pagesRead,
            messagePagination: 'verified',
            messageHistory:
              startReached &&
              endReached &&
              ![...reasons].some((r) => !r.startsWith('attachment') && r !== 'contact_unavailable')
                ? 'complete'
                : 'partial',
            attachmentListing: attachmentListing?.complete ? 'complete' : 'partial',
            history: {
              startReached,
              endReached,
              messagesRead: messages.size,
              pagesRead,
              complete:
                startReached &&
                endReached &&
                ![...reasons].some((r) => !r.startsWith('attachment') && r !== 'contact_unavailable'),
            },
            editedMessageContent: { status: 'unavailable', reason: 'upstream_whatsapp_api_limitation' },
          },
          ...(continuation ? { continuation } : {}),
        };
        await progress.onProgress?.(snapshot);
        return snapshot;
      };
      // Persist metadata even when the very first message request is deferred.
      await finish();
      if (endReached) {
        continuation = undefined;
        return finish();
      }
      const maxMessagePages = progress.maxMessagePages ?? Infinity;
      for (let batch = 0; batch < 10 && messages.size < 10000 && pagesRead < maxMessagePages; batch++) {
        let page: MessagePage;
        try {
          page = await deps.listMessages(conversation.id, { after });
        } catch (error) {
          if (!messages.size || (error instanceof SafeError && error.code === 'MCP_UNAUTHORIZED')) throw error;
          reasons.add(error instanceof SafeError && error.retryable ? 'history_read_deferred' : 'history_query_failed');
          return finish();
        }
        pagesRead++;
        if (page.conversationId !== conversation.id) {
          reasons.add('conversation_mismatch');
          continuation = undefined;
          return finish();
        }
        for (const reason of page.coverage.missingReasons)
          if (!['history_start_not_reached', 'history_end_not_reached'].includes(reason)) reasons.add(reason);
        let last = after;
        for (const message of page.messages) {
          if (
            (message.conversationId !== undefined && message.conversationId !== conversation.id) ||
            message.id <= last
          ) {
            reasons.add('message_cursor_invalid');
            continuation = undefined;
            return finish();
          }
          last = message.id;
          messages.set(message.id, message);
        }
        const next = page.continuation;
        if (!next) {
          endReached = page.coverage.history?.endReached ?? page.coverage.complete;
          continuation = undefined;
          return finish();
        }
        if (seen.has(next.after) || next.after <= after) {
          reasons.add('cursor_repeated');
          continuation = undefined;
          return finish();
        }
        if (
          next.conversationId !== conversation.id ||
          !Number.isSafeInteger(next.after) ||
          next.after <= 0 ||
          next.after !== last
        ) {
          reasons.add('cursor_invalid');
          continuation = undefined;
          return finish();
        }
        seen.add(next.after);
        after = next.after;
        continuation = next;
        if (pagesRead >= maxMessagePages) break;
        await finish();
      }
      if (pagesRead >= maxMessagePages) {
        reasons.add('message_page_limit');
        continuation = undefined;
      } else reasons.add('history_read_limit');
      return finish();
    },
  };
}
