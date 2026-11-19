import { parseInput } from '../../agendor/crm/schemas';
import { TENANT_ACCOUNT_KEY } from '../../app/config/tenant';
import { authorizePlan, requireAutomationOperation } from '../../domain/authorization';
import { SafeError } from '../../shared/errors';
import { readJson } from '../../shared/json';
import { runPlan } from '../execution/executor';
import { createQueueExecutionDeps, enqueueOperation } from '../execution/queue';
import { applyInputSchema } from '../schemas';
import { servicePlanEnvelopeSchema } from '../service-state';
import type { OperationStatus } from '../types';
import { automationActor, owns, readWorkflow, unavailable, type WorkflowContext } from './context';
import { enforceInboxPolicy } from './policy';

export async function apply(ctx: WorkflowContext, raw: unknown): Promise<OperationStatus> {
  requireAutomationOperation(ctx.auth, 'apply');
  automationActor(ctx.auth);
  const input = parseInput(applyInputSchema, raw);
  const policy = await ctx.policy();
  if (policy.mode !== 'apply')
    throw new SafeError('POLICY_BLOCKED', 'The current policy does not authorize plan application.', false, 403);
  // Context publication invalidates the source plan. An exact completed
  // replay still returns its receipt without reauthorizing any dispatch.
  const prior = await ctx.repository.getOperationByRequest(input.requestId);
  if (prior?.status.state === 'applied') {
    const caller = automationActor(ctx.auth);
    const original = prior.input.authorization;
    const workflow = await readWorkflow(ctx.repository, prior.input.basis.lease.workId);
    if (
      original.actor.userId !== caller.userId ||
      original.actor.clientId !== caller.clientId ||
      original.plan.planId !== input.planId ||
      original.plan.version !== input.planVersion ||
      !workflow ||
      workflow.chatAccountId !== ctx.env.AGENDOR_CHAT_ACCOUNT_ID
    )
      return unavailable();
    return prior.status;
  }
  const storedJson = await ctx.repository.getServicePlan(input.planId);
  if (!storedJson) return unavailable();
  const stored = readJson(servicePlanEnvelopeSchema, storedJson, 'servicePlan');
  owns(stored.workflow, ctx.auth, ctx.env);
  const { plan, workflow } = stored;
  if (plan.version !== input.planVersion || workflow.lease.mode !== 'apply' || !workflow.basis || !workflow.catalog)
    return unavailable('Preview or stale plans cannot be applied.');
  enforceInboxPolicy(workflow.conversations, policy);
  const authorization = authorizePlan(ctx.auth, plan, policy);
  const operation = await ctx.repository.prepareOperation({
    requestId: input.requestId,
    accountKey: TENANT_ACCOUNT_KEY,
    authorization,
    basis: workflow.basis,
    catalogJson: JSON.stringify(workflow.catalog),
  });
  const deps = await createQueueExecutionDeps(
    { accountKey: TENANT_ACCOUNT_KEY, operationId: operation.operationId, version: operation.version },
    ctx.env,
  );
  const status = await runPlan(authorization, { ...deps, signal: ctx.signal, defer: true });
  if (status.state === 'queued')
    await enqueueOperation(operation.operationId, {
      repository: ctx.repository,
      accountKey: TENANT_ACCOUNT_KEY,
      queue: ctx.env.AUTOMATION_QUEUE,
    });
  return status;
}
