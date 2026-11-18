/** Outbound quota reservation gate injected into Agendor adapters. */
export interface BudgetGate {
  (): Promise<void>;
}

/** Inbox allowlist guard injected into Agendor Chat adapters. */
export interface InboxGuard {
  isAllowed(inboxId: number | undefined): boolean;
  assertAllowed(conversation: { inboxId?: number }): void;
}
