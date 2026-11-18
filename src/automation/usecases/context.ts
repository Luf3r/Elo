import { parseInput } from '../../agendor/crm/schemas';
import { requireCapabilities, type AuthContext } from '../../auth';
import { requireAutomationOperation } from '../../domain/authorization';
import type { Env } from '../../env';
import { SafeError } from '../../shared/errors';
import { readJson } from '../../shared/json';
import { discoverySettings } from '../discovery';
import { customerContextInputSchema } from '../schemas';
import { workflowStateSchema, type WorkflowState } from '../service-state';
import { accountState } from '../state/budget';
import type { AutomationPolicy } from '../types';
import { defaultAutomationPolicy, type PreparationRequest } from './policy';

export interface WorkflowContext {
  env: Env;
  auth: AuthContext;
  signal?: AbortSignal;
  readonly repository: ReturnType<typeof accountState>;
  policy: () => Promise<AutomationPolicy>;
}

export function createWorkflowContext(env: Env, auth: AuthContext, signal?: AbortSignal): WorkflowContext {
  return {
    env,
    auth,
    signal,
    get repository() {
      return accountState(env);
    },
    policy: async () => (await accountState(env).getExecutionPolicy()) ?? structuredClone(defaultAutomationPolicy),
  };
}

export const unavailable = (message = 'Work is unavailable or stale; prepare again.'): never => {
  throw new SafeError('INVALID_INPUT', message, false, 409);
};

export function automationActor(auth: AuthContext) {
  requireCapabilities(auth, []);
  if (!auth.userId || !auth.clientId || !auth.expiresAt || auth.expiresAt <= Date.now())
    throw new SafeError('MCP_UNAUTHORIZED', 'A current, expiring actor authorization is required.', false, 403);
  return { userId: auth.userId, clientId: auth.clientId, scopes: [...auth.scopes], expiresAt: auth.expiresAt };
}

export function owns(state: WorkflowState, auth: AuthContext, env: Env) {
  const caller = automationActor(auth);
  if (
    state.lease.owner.userId !== caller.userId ||
    state.lease.owner.clientId !== caller.clientId ||
    Date.parse(state.lease.expiresAt) <= Date.now() ||
    (state.chatAccountId !== undefined && state.chatAccountId !== env.AGENDOR_CHAT_ACCOUNT_ID)
  )
    unavailable();
}

export async function persistWorkflow(repository: ReturnType<typeof accountState>, state: WorkflowState) {
  const expected = state.revision;
  state.revision++;
  await repository.saveWorkflow(state, expected);
}

export async function readWorkflow(
  repository: ReturnType<typeof accountState>,
  id: string,
): Promise<WorkflowState | undefined> {
  const json = await repository.getWorkflow(id);
  return json ? readJson(workflowStateSchema, json, 'workflow') : undefined;
}

export async function loadWorkflow(ctx: WorkflowContext, id: string) {
  const state = await readWorkflow(ctx.repository, id);
  if (!state) return unavailable();
  owns(state, ctx.auth, ctx.env);
  return state;
}

export async function createReview(ctx: WorkflowContext, state: WorkflowState, reasons: string[]) {
  const reviewId = 'review:' + state.lease.workId + ':' + (state.work?.snapshotVersion ?? state.snapshotVersion ?? 1);
  await ctx.repository.putReview({
    reviewId,
    workId: state.lease.workId,
    customerId: state.customerId,
    version: 1,
    snapshotVersion: state.work?.snapshotVersion ?? state.snapshotVersion ?? 1,
    owner: state.lease.owner,
    state: 'open',
    reasons: [...new Set(reasons)].slice(0, 100),
  });
  return reviewId;
}

export async function loadPendingActivity(ctx: WorkflowContext, id: string, request: PreparationRequest) {
  const event = await ctx.repository.getPendingActivity(id);
  if (
    !event ||
    event.accountId !== ctx.env.AGENDOR_CHAT_ACCOUNT_ID ||
    request.mode !== 'preview' ||
    request.target.kind !== 'conversation' ||
    request.target.conversationId !== event.conversationId ||
    request.inboxIds?.length !== 1 ||
    request.inboxIds[0] !== event.inboxId
  )
    return unavailable('Pending activity is unavailable or outside the requested scope.');
  if (discoverySettings(ctx.env, await ctx.policy(), [event.inboxId]).reason)
    throw new SafeError('MCP_UNAUTHORIZED', 'Pending activity scope is not authorized.', false, 403);
  return event;
}

export async function getCustomerContext(ctx: WorkflowContext, customerId: string, demandId?: string) {
  requireAutomationOperation(ctx.auth, 'context');
  automationActor(ctx.auth);
  const input = parseInput(customerContextInputSchema, { customerId, ...(demandId ? { demandId } : {}) });
  const context = await ctx.repository.getContext(input.customerId);
  return input.demandId
    ? { ...context, demand: await ctx.repository.getCustomerDemand(input.customerId, input.demandId) }
    : context;
}
