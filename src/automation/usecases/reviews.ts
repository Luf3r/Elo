import { parseInput } from '../../agendor/crm/schemas';
import { requireAutomationOperation } from '../../domain/authorization';
import { listReviewsInputSchema, reviewResolutionInputSchema } from '../schemas';
import { automationActor, type WorkflowContext } from './context';

export async function listReviews(ctx: WorkflowContext, raw: unknown) {
  requireAutomationOperation(ctx.auth, 'reviews');
  const caller = automationActor(ctx.auth);
  return ctx.repository.listReviews(parseInput(listReviewsInputSchema, raw), caller);
}

export async function resolveReview(ctx: WorkflowContext, raw: unknown) {
  requireAutomationOperation(ctx.auth, 'resolveReview');
  const caller = automationActor(ctx.auth);
  const input = parseInput(reviewResolutionInputSchema, raw);
  return { review: await ctx.repository.resolveReview(input, caller), actionRequired: 'prepare' as const };
}
