export interface Coverage {
  complete: boolean;
  missingReasons: string[];
  pagesRead: number;
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
export interface ConversationContinuation { conversationId: number; after: number }
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
export interface AttachmentPage { attachments: AttachmentMetadata[]; coverage: Coverage }
export interface ConversationSnapshot {
  conversationId: number;
  /** Hash of the observed snapshot, not a claim of upstream revision or complete history. */
  revision: string;
  contact: ChatContact | null;
  messages: ChatMessage[];
  attachments: AttachmentMetadata[];
  coverage: Coverage;
  continuation?: ConversationContinuation;
}
export interface AttachmentInput { conversationId: number; attachmentId: number }
export type AttachmentResult = {
  conversationId: number;
  attachmentId: number;
  status: 'available' | 'unavailable';
  pending: boolean;
  reason?: string;
  mimeType?: string;
  text?: string;
  data?: string;
  resource?: { type: 'resource_link'; uri: string; name: string; mimeType?: string };
};
