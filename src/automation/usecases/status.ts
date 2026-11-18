import { z } from 'zod';
import { parseInput } from '../../agendor/crm/schemas';
import { requireAutomationOperation } from '../../domain/authorization';
import { createAgendorCrmClient } from '../clients';
import { reconcileCommand } from '../execution/reconciliation';
import { automationActor, readWorkflow, unavailable, type WorkflowContext } from './context';

const key = z.string().trim().min(1).max(200);

export async function getStatus(ctx: WorkflowContext) {
  requireAutomationOperation(ctx.auth, 'status');
  const caller = automationActor(ctx.auth);
  return ctx.repository.getServiceStatus(caller);
}

export async function getOperation(ctx: WorkflowContext, raw: string) {
  requireAutomationOperation(ctx.auth, 'operation');
  const id = parseInput(key, raw);
  const caller = automationActor(ctx.auth);
  const operation = await ctx.repository.getOperation(id);
  if (
    !operation ||
    operation.input.authorization.actor.userId !== caller.userId ||
    operation.input.authorization.actor.clientId !== caller.clientId
  )
    return unavailable('Operation unavailable.');
  const workflow = await readWorkflow(ctx.repository, operation.input.basis.lease.workId);
  if (!workflow || (workflow.chatAccountId !== undefined && workflow.chatAccountId !== ctx.env.AGENDOR_CHAT_ACCOUNT_ID))
    return unavailable('Operation unavailable.');
  if (operation.status.state !== 'uncertain') return operation.status;
  const reads = createAgendorCrmClient(ctx.env, { signal: ctx.signal });
  const results = [];
  for (const command of operation.input.authorization.plan.orderedCommands)
    results.push(await reconcileCommand(command.commandKey, { repository: ctx.repository, reads }));
  const pending = results.flatMap((r) => (r.state === 'confirmed' ? [] : r.reviewReasons));
  const status = await ctx.repository.setOperationStatus(id, {
    operationId: id,
    state: results.every((r) => r.state === 'confirmed')
      ? 'applied'
      : results.some((r) => r.state === 'review')
        ? 'review'
        : 'uncertain',
    receipts: [],
    pendingReasons: [...new Set(pending)].slice(0, 100),
  });
  if (status.state === 'applied') await ctx.repository.publishOperationContext(id);
  return status;
}
