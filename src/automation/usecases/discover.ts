import { parseInput } from '../../agendor/crm/schemas';
import { requireAutomationOperation } from '../../domain/authorization';
import { discoverPending, discoveryInputSchema } from '../discovery';
import { automationActor, type WorkflowContext } from './context';

export async function discover(ctx: WorkflowContext, raw: unknown) {
  requireAutomationOperation(ctx.auth, 'discover');
  const { userId, clientId } = automationActor(ctx.auth);
  return discoverPending(ctx.env, { userId, clientId }, parseInput(discoveryInputSchema, raw), ctx.policy, ctx.signal);
}
