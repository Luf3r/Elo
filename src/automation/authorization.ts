import { requireCapabilities, type AuthContext } from '../auth';
import { SafeError } from '../errors';
import { automationPolicySchema } from './policy-types';
import { authorizedPlanSchema, syncPlanSchema, workLeaseSchema } from './schemas';
import type { AnalysisInput, AuthorizedPlan, AutomationPolicy, Capability, MutationCommand, SyncPlan, WorkLease } from './types';

export const automationOperationCapabilities = {
  prepare: ['automation:process', 'chat:read', 'crm:read'],
  submit: ['automation:process', 'chat:read', 'crm:read'],
  apply: ['automation:process'],
  operation: ['automation:read'],
  context: ['automation:read', 'chat:read', 'crm:read'],
  reviews: ['automation:read', 'chat:read', 'crm:read'],
  resolveReview: ['automation:manage', 'chat:read', 'crm:read'],
  status: ['automation:read'],
  updatePolicy: ['automation:manage'],
  reprocess: ['automation:manage', 'chat:read', 'crm:read'],
} as const satisfies Record<string, readonly Capability[]>;
export type AutomationOperation = keyof typeof automationOperationCapabilities;

export function requireAutomationOperation(auth: AuthContext, operation: AutomationOperation): void {
  requireCapabilities(auth, automationOperationCapabilities[operation]);
}

/** Enabling CRM mutations in policy requires the corresponding caller grants. */
export function requirePolicyCapabilities(auth: AuthContext, policy: AutomationPolicy): void {
  requireAutomationOperation(auth, 'updatePolicy');
  requireCapabilities(auth, policy.capabilities.filter(c => c === 'crm:create' || c === 'crm:enrich' || c === 'crm:write'));
}

const commandCapability = {
  legacy_update_organization: 'crm:write', legacy_update_person: 'crm:write', legacy_update_deal: 'crm:write', legacy_update_stage: 'crm:write',
  create_organization: 'crm:create', create_person: 'crm:create', create_deal: 'crm:create', create_task: 'crm:create',
  enrich_organization: 'crm:enrich', enrich_person: 'crm:enrich', enrich_deal: 'crm:enrich', update_task: 'crm:enrich',
  change_stage: 'crm:write',
} as const satisfies Record<MutationCommand['kind'], Capability>;

function deny(message: string): never {
  throw new SafeError('MCP_UNAUTHORIZED', message, false, 403);
}

/** Only a server-loaded plan and current policy may cross this boundary.
 * Ownership/lease/snapshot checks belong to submission and the state service.
 * Operator evidence is internal provenance, never a substitute for capabilities.
 */
export function authorizePlan(auth: AuthContext, plan: SyncPlan, policy: AutomationPolicy): AuthorizedPlan {
  const authorizationTime = Date.now();
  requireAutomationOperation(auth, 'apply');
  const expiry = auth.expiresAt;
  if (!auth.userId || !auth.clientId || expiry === undefined || !Number.isFinite(expiry) || expiry <= authorizationTime) {
    deny('A current, expiring authorization is required.');
  }
  const parsedPlan = syncPlanSchema.safeParse(plan);
  const parsedPolicy = automationPolicySchema.safeParse(policy);
  if (!parsedPlan.success || !parsedPolicy.success) deny('Invalid plan or policy.');
  const snapshot = parsedPlan.data;
  const currentPolicy = parsedPolicy.data;
  if (currentPolicy.mode !== 'apply' || snapshot.policyVersion !== currentPolicy.version || snapshot.state === 'review') {
    deny('Plan is not authorized by the current policy.');
  }
  if (!currentPolicy.nativeCreatorDisabled && snapshot.orderedCommands.some(command => command.kind === 'create_person')) deny('Native creator mode must be disabled before person creation is authorized.');
  const commandCapabilities = snapshot.orderedCommands.map(command => {
    // Ignore claims made by requiredCapabilities; derive from the closed command kind.
    const capability = commandCapability[command.kind];
    requireCapabilities(auth, [capability]);
    if (!currentPolicy.capabilities.includes(capability)) deny('Command capability is disabled by policy.');
    command.requiredCapabilities = [capability];
    return { commandKey: command.commandKey, capabilities: [capability] };
  });
  return authorizedPlanSchema.parse({
    plan: snapshot,
    actor: { userId: auth.userId, clientId: auth.clientId, scopes: [...auth.scopes], expiresAt: expiry },
    commandCapabilities,
    validUntil: new Date(Math.min(expiry, authorizationTime + 300_000)).toISOString(),
  });
}

/** Call before validating analysis against the server-loaded snapshot manifest.
 * This checks identity only; it does not load state or establish source provenance.
 */
export function authorizeSubmission(auth: AuthContext, input: AnalysisInput, lease: WorkLease): void {
  requireAutomationOperation(auth, 'submit');
  const parsed = workLeaseSchema.safeParse(lease);
  if (!parsed.success || !auth.userId || !auth.clientId) deny('Invalid work authorization.');
  const work = parsed.data;
  if (auth.userId !== work.owner.userId || auth.clientId !== work.owner.clientId || input.workId !== work.workId ||
      input.leaseToken !== work.leaseToken || Date.parse(work.expiresAt) <= Date.now()) {
    deny('Work authorization is stale or belongs to another caller.');
  }
}
