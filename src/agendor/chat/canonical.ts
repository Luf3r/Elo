import { assertInboxAllowed } from '../../automation/inbox-policy';
import { SafeError } from '../../errors';
import type { ChatContact } from './types';
interface Dependencies {
  getConversation(id: number): Promise<{ id: number; inboxId?: number; contact?: ChatContact | null }>;
  getContact(id: number): Promise<{ contact: ChatContact | null }>;
}
/** Read the authorized conversation first, then renew its contact from the
 * individual route before trusting the native CRM identity. */
export async function readCanonicalConversation(
  deps: Dependencies,
  id: number,
  policy: { allowedInboxIds: readonly number[] },
) {
  const conversation = await deps.getConversation(id);
  assertInboxAllowed(conversation, policy);
  if (conversation.id !== id) throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Conversation identity changed.', false);
  if (!conversation.contact) return conversation;
  const contact = await deps.getContact(conversation.contact.id);
  if (!contact.contact || contact.contact.id !== conversation.contact.id)
    throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Contact identity unavailable.', false);
  return { ...conversation, contact: contact.contact };
}
