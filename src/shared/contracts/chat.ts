export interface Coverage {
  complete: boolean;
  missingReasons: string[];
  pagesRead: number;
  paginationProbe?: {
    pagesScanned: number;
    nextPage: number | null;
    emptyPage?: number;
    stoppedBy: 'page_limit' | 'page_repeated' | 'read_deferred' | 'read_error' | 'explicit_end';
  };
  history?: { startReached: boolean; endReached: boolean; messagesRead: number; pagesRead: number; complete: boolean };
  messagePagination?: 'verified';
  messageHistory?: 'complete' | 'partial';
  conversationDiscovery?: 'complete' | 'partial';
  attachmentListing?: 'complete' | 'partial';
  editedMessageContent?: { status: 'unavailable'; reason: 'upstream_whatsapp_api_limitation' };
  conversationsRead?: number;
  attachmentCount?: number;
}
export interface ChatContact {
  id: number;
  name?: string;
  email?: string;
  phoneNumber?: string;
  crmPersonId?: number;
}
export interface ChatMessage {
  id: number;
  conversationId?: number;
  content?: string;
  createdAt?: number;
  updatedAt?: number;
  private?: boolean;
  senderType?: string;
  senderName?: string;
  senderId?: number;
  messageType?: string | number;
  attachments?: AttachmentMetadata[];
  direction?: 'incoming' | 'outgoing' | 'activity' | 'unknown';
}
export interface AttachmentMetadata {
  id: number;
  fileType?: string;
  mimeType?: string;
  byteSize?: number;
  messageId?: number;
}
/** Only an adapter with verified pagination semantics may produce this cursor. */
export interface ConversationContinuation {
  conversationId: number;
  after: number;
}
export interface ConversationReadInput {
  conversationId: number;
  after?: number;
  continuation?: ConversationContinuation;
}
export interface MessagePage {
  conversationId: number;
  messages: ChatMessage[];
  coverage: Coverage;
  continuation?: ConversationContinuation;
}
export interface AttachmentPage {
  attachments: AttachmentMetadata[];
  coverage: Coverage;
  pageInfo?: { page: number; nextPage: number | null; hasNext: boolean | null; endReached: boolean; complete: boolean };
}
export interface ConversationSnapshot {
  conversationId: number;
  inboxId?: number;
  /** Hash of the observed snapshot, not a claim of upstream revision or complete history. */
  revision: string;
  contact: ChatContact | null;
  messages: ChatMessage[];
  attachments: AttachmentMetadata[];
  coverage: Coverage;
  attachmentListing?: {
    complete: boolean;
    pagesRead: number;
    nextPage: number | null;
    endReached: boolean;
    missingReasons: string[];
    source?: 'attachment_endpoint' | 'message_history' | 'combined';
    messagePagesRead?: number;
  };
  continuation?: ConversationContinuation;
}
export interface AttachmentInput {
  conversationId: number;
  attachmentId: number;
  offset?: number;
  expectedSha256?: string;
  listingPage?: number;
}
export type AttachmentResult = {
  conversationId: number;
  attachmentId: number;
  status: 'available' | 'unavailable';
  pending: boolean;
  reason?: string;
  mimeType?: string;
  blockedHost?: string;
  nextListingPage?: number | null;
  offset?: number;
  nextOffset?: number | null;
  totalBytes?: number;
  sha256?: string;
  contentComplete?: boolean;
  text?: string;
  data?: string;
  resource?: { type: 'resource_link'; uri: string; name: string; mimeType?: string };
};
