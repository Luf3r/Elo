import { SafeError } from '../errors';
/** Expansion is a deliberate code/policy change, never derived from upstream data. */
export const allowedInboxIds: readonly number[] = Object.freeze([4101, 4102]);
export function isInboxAllowed(inboxId: number | undefined, policy?: { allowedInboxIds: readonly number[] }): boolean {
  return (
    inboxId !== undefined &&
    allowedInboxIds.includes(inboxId) &&
    (policy === undefined || policy.allowedInboxIds.includes(inboxId))
  );
}
export function assertInboxAllowed(
  conversation: { inboxId?: number },
  policy?: { allowedInboxIds: readonly number[] },
): void {
  if (!isInboxAllowed(conversation.inboxId, policy))
    throw new SafeError('MCP_UNAUTHORIZED', 'Conversation inbox is not authorized.', false, 403);
}
