import { parseInput } from '../../agendor/crm/schemas';
import { requireAutomationOperation } from '../../domain/authorization';
import { reprocessInputSchema } from '../schemas';
import { automationActor, type WorkflowContext } from './context';
import { prepareWork } from './prepare';

export async function reprocess(ctx: WorkflowContext, raw: unknown) {
  requireAutomationOperation(ctx.auth, 'reprocess');
  const caller = automationActor(ctx.auth);
  const input = parseInput(reprocessInputSchema, raw);
  await ctx.repository.recordReprocess(input.requestId, caller);
  return prepareWork(
    ctx,
    { requestId: input.requestId, target: input.target, mode: input.mode },
    { from: input.from, to: input.to },
  );
}
