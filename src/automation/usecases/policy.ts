import { z } from 'zod';
import { parseInput } from '../../agendor/crm/schemas';
import { requireAutomationOperation, requirePolicyCapabilities } from '../../domain/authorization';
import { allowedInboxIds, assertInboxAllowed, isInboxAllowed } from '../../domain/inbox-policy';
import { automationPolicySchema, updatePolicyInputSchema } from '../../domain/policy-types';
import { maxPreparationPages, preflightInputSchema } from '../../domain/schemas/snapshot';
import { SafeError } from '../../shared/errors';
import type { AutomationPolicy } from '../types';
import { automationActor, unavailable, type WorkflowContext } from './context';

export const defaultAutomationPolicy: AutomationPolicy = {
  version: 1,
  mode: 'disabled',
  allowedInboxIds: [...allowedInboxIds],
  capabilities: [],
  funnelMapping: {},
  stageMapping: [],
  customFieldMapping: [],
  nativeCreatorDisabled: false,
  limits: { maxConversations: 10, maxCommands: 20, maxRequests: 20 },
};

export type PreparationRequest = z.infer<typeof preflightInputSchema>;

export function enforceInboxPolicy(
  conversations: Array<{ inboxId?: number }>,
  policy: { allowedInboxIds: readonly number[] },
): void {
  conversations.forEach((c) => assertInboxAllowed(c, policy));
}

export function preparationSettings(policy: AutomationPolicy, input: PreparationRequest) {
  const authorized = allowedInboxIds.filter((id) => isInboxAllowed(id, policy));
  const inboxIds = input.inboxIds ? [...new Set(input.inboxIds)] : authorized;
  const reason =
    !inboxIds.length || inboxIds.some((id) => !authorized.includes(id))
      ? 'INBOX_SCOPE_NOT_AUTHORIZED'
      : input.mode === 'apply' && policy.mode !== 'apply'
        ? 'APPLY_MODE_NOT_AUTHORIZED'
        : null;
  const limits = {
    maxConversations: input.target.kind === 'conversation' ? 1 : Math.min(policy.limits.maxConversations, 10),
    maxMessagePages: input.limits?.maxMessagePages ?? maxPreparationPages,
    maxAttachmentPages: input.limits?.maxAttachmentPages ?? maxPreparationPages,
    messagePageSize: 100,
    messagePagesPerBatch: 10,
    attachmentPagesPerBatch: 3,
    crmCatalogAndHydrationRequestsPerCall: policy.limits.maxRequests,
  };
  return { authorized, inboxIds, reason, limits };
}

export function authorizePreparation(policy: AutomationPolicy, input: PreparationRequest) {
  const settings = preparationSettings(policy, input);
  if (input.target.kind === 'pending')
    unavailable('Use automation_discover_pending to find work, then prepare a returned conversation.');
  if (settings.reason)
    throw new SafeError('MCP_UNAUTHORIZED', 'Requested preparation scope or mode is not authorized.', false, 403);
  return settings;
}

export async function updatePolicy(ctx: WorkflowContext, raw: unknown) {
  requireAutomationOperation(ctx.auth, 'updatePolicy');
  const caller = automationActor(ctx.auth);
  const input = parseInput(updatePolicyInputSchema, raw);
  const policy = automationPolicySchema.parse({
    ...(await ctx.policy()),
    ...input.patch,
    version: input.expectedVersion + 1,
  });
  requirePolicyCapabilities(ctx.auth, policy);
  return ctx.repository.updatePolicy(policy, input.expectedVersion, caller);
}
