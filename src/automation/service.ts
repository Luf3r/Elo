import type { AuthContext } from '../auth';
import type { Env } from '../env';
import type { PrepareInput } from './types';
import { apply } from './usecases/apply';
import { getAudit } from './usecases/audit';
import {
  automationActor,
  createWorkflowContext,
  getCustomerContext,
  persistWorkflow,
  readWorkflow,
} from './usecases/context';
import { discover } from './usecases/discover';
import { defaultAutomationPolicy, updatePolicy } from './usecases/policy';
import { preflight } from './usecases/preflight';
import { prepare } from './usecases/prepare';
import { reprocess } from './usecases/reprocess';
import { listReviews, resolveReview } from './usecases/reviews';
import { getOperation, getStatus } from './usecases/status';
import { submit } from './usecases/submit';

export { defaultAutomationPolicy, automationActor, persistWorkflow, readWorkflow };

/** Authorization precedes adapter construction. Account, evidence and commands
 * are always loaded from server-owned state rather than caller claims. */
export function createAutomationService(env: Env, auth: AuthContext, signal?: AbortSignal) {
  const ctx = createWorkflowContext(env, auth, signal);
  return {
    discover: (raw: unknown) => discover(ctx, raw),
    preflight: (raw: unknown) => preflight(ctx, raw),
    prepare: (input: PrepareInput) => prepare(ctx, input),
    submit: (raw: unknown) => submit(ctx, raw),
    apply: (raw: unknown) => apply(ctx, raw),
    getOperation: (raw: string) => getOperation(ctx, raw),
    getCustomerContext: (customerId: string, demandId?: string) => getCustomerContext(ctx, customerId, demandId),
    listReviews: (raw: unknown) => listReviews(ctx, raw),
    resolveReview: (raw: unknown) => resolveReview(ctx, raw),
    getStatus: () => getStatus(ctx),
    getAudit: (raw: unknown) => getAudit(ctx, raw),
    updatePolicy: (raw: unknown) => updatePolicy(ctx, raw),
    reprocess: (raw: unknown) => reprocess(ctx, raw),
  };
}
