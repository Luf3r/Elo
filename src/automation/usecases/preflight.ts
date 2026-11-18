import { parseInput } from '../../agendor/crm/schemas';
import { requireAutomationOperation } from '../../domain/authorization';
import {
  discoveryCursorMs,
  discoveryLookbackMs,
  discoverySettings,
  discoveryTool,
  maxDiscoveryPages,
} from '../discovery';
import { preflightInputSchema } from '../schemas';
import { automationActor, type WorkflowContext } from './context';
import { defaultAutomationPolicy, preparationSettings } from './policy';

export async function preflight(ctx: WorkflowContext, raw: unknown) {
  requireAutomationOperation(ctx.auth, 'preflight');
  const identity = automationActor(ctx.auth);
  const input = parseInput(preflightInputSchema, raw);
  const scope = {
    target: input.target,
    requestedMode: input.mode,
    requestedInboxIds: input.inboxIds ?? null,
    conversationVerification: 'required_at_prepare' as const,
    upstreamDetailMayIncludeMessages: true,
  };
  let infrastructure;
  try {
    infrastructure = await ctx.repository.getPreparationInfrastructure();
  } catch {
    return {
      state: 'blocked',
      reason: 'STATE_UNAVAILABLE',
      identity,
      policyVersion: null,
      policyMode: null,
      effectiveMode: null,
      allowedInboxIds: null,
      scope: { ...scope, inboxIds: null },
      limits: null,
      persistence: { available: false },
      concurrency: { available: false },
    };
  }
  const policy = infrastructure.policy ?? defaultAutomationPolicy;
  const settings = preparationSettings(policy, input);
  const pending = input.target.kind === 'pending';
  const discovery = pending ? discoverySettings(ctx.env, policy, input.inboxIds) : undefined;
  const reason =
    settings.reason ?? (pending && input.mode !== 'preview' ? 'DISCOVERY_PREVIEW_ONLY' : (discovery?.reason ?? null));
  return {
    state: reason ? 'blocked' : pending ? 'ready_for_discovery' : 'ready_for_scope_check',
    reason,
    identity,
    ...(pending
      ? {
          discovery: {
            tool: discoveryTool,
            mode: 'preview',
            maxPagesPerCall: 1,
            inboxInventoryCheckedBeforeEachCall: true,
            maxPagesPerInbox: maxDiscoveryPages,
            cursorSeconds: discoveryCursorMs / 1000,
            lookbackSeconds: discoveryLookbackMs / 1000,
          },
        }
      : {}),
    policyVersion: policy.version,
    policyMode: policy.mode,
    effectiveMode: input.mode === 'preview' ? 'preview' : policy.mode,
    allowedInboxIds: settings.authorized,
    scope: { ...scope, inboxIds: reason ? [] : settings.inboxIds },
    limits: settings.limits,
    persistence: { available: true, mechanism: 'durable_object_sqlite' },
    concurrency: { available: true, mechanism: 'target_lease', leaseSeconds: 600, preparationLockSeconds: 60 },
  };
}
