import {
  createAgendorChatClient as createChatAdapter,
  createConversationReader,
  type ChatClientOptions,
} from '../agendor/chat/client';
import { readCanonicalConversation as readCanonicalConversationAdapter } from '../agendor/chat/canonical';
import type { ChatContact } from '../agendor/chat/types';
import { createAgendorCrmClient as createCrmAdapter, type CrmClientOptions } from '../agendor/crm/client';
import {
  createCrmMutationClient as createCrmMutationAdapter,
  type CrmMutationDependencies,
} from '../agendor/crm/mutations';
import type { AgendorCrmClient, CrmMutationClient } from '../agendor/crm/types';
import type { InboxGuard } from '../agendor/ports';
import { assertInboxAllowed, isInboxAllowed } from '../domain/inbox-policy';
import type { Env } from '../env';
import { createBudgetGate } from './state/budget';

export { createConversationReader };

export type AutomationChatClientOptions = Omit<ChatClientOptions, 'budgetGate' | 'inboxGuard'> &
  Partial<Pick<ChatClientOptions, 'budgetGate' | 'inboxGuard'>>;

export type AutomationCrmClientOptions = Omit<CrmClientOptions, 'budgetGate'> &
  Partial<Pick<CrmClientOptions, 'budgetGate'>>;

export type AutomationCrmMutationDependencies = Omit<CrmMutationDependencies, 'env' | 'budgetGate'> & {
  env: Pick<Env, 'AGENDOR_CRM_TOKEN'> & Partial<Pick<Env, 'AUTOMATION_STATE'>>;
  budgetGate?: CrmMutationDependencies['budgetGate'];
};

export function createInboxGuard(policy?: { allowedInboxIds: readonly number[] }): InboxGuard {
  return {
    isAllowed: (inboxId) => isInboxAllowed(inboxId, policy),
    assertAllowed: (conversation) => assertInboxAllowed(conversation, policy),
  };
}

export function createAgendorChatClient(
  env: Pick<Env, 'AGENDOR_CHAT_TOKEN' | 'AGENDOR_CHAT_ACCOUNT_ID'> & Partial<Pick<Env, 'AUTOMATION_STATE'>>,
  options: AutomationChatClientOptions = {},
) {
  return createChatAdapter(env, {
    ...options,
    budgetGate: options.budgetGate ?? createBudgetGate(env, 'chat'),
    inboxGuard: options.inboxGuard ?? createInboxGuard(),
  });
}

export function createAgendorCrmClient(
  env: Pick<Env, 'AGENDOR_CRM_TOKEN'> & Partial<Pick<Env, 'AUTOMATION_STATE'>>,
  options: AutomationCrmClientOptions = {},
): AgendorCrmClient {
  return createCrmAdapter(env, {
    ...options,
    budgetGate: options.budgetGate ?? createBudgetGate(env, 'crm'),
  });
}

export function createCrmMutationClient(deps: AutomationCrmMutationDependencies): CrmMutationClient {
  return createCrmMutationAdapter({
    ...deps,
    budgetGate: deps.budgetGate ?? createBudgetGate(deps.env, 'crm'),
  });
}

export function readCanonicalConversation(
  deps: {
    getConversation(id: number): Promise<{ id: number; inboxId?: number; contact?: ChatContact | null }>;
    getContact(id: number): Promise<{ contact: ChatContact | null }>;
  },
  id: number,
  policy: { allowedInboxIds: readonly number[] } | InboxGuard,
) {
  const guard = 'assertAllowed' in policy ? policy : createInboxGuard(policy);
  return readCanonicalConversationAdapter(deps, id, guard);
}
