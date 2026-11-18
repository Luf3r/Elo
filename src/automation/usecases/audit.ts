import { parseInput } from '../../agendor/crm/schemas';
import { requireAutomationOperation } from '../../domain/authorization';
import { auditInputSchema } from '../schemas';
import { automationActor, type WorkflowContext } from './context';

export async function getAudit(ctx: WorkflowContext, raw: unknown) {
  requireAutomationOperation(ctx.auth, 'status');
  const caller = automationActor(ctx.auth);
  return ctx.repository.listAudit(parseInput(auditInputSchema, raw), caller);
}
