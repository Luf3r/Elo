import type { CrmMutationClient, CatalogSnapshot, MutationOutcome } from '../agendor/crm/types';
import type { AuthorizedPlan, MutationCommand, OperationReceipt, OperationStatus, PlanBasis } from './types';
import type { AsyncRepository, ExecutionCommand, ExecutionOperation } from './operations';
import { authorizedPlanSchema } from './schemas';
import { checkedReceipt, reconcileCommand, resolvedTarget, type ReconciliationReads } from './reconciliation';
import { safeError } from '../errors';

export interface ExecutionDeps {
  legacy?: Pick<import('../agendor/crm/types').AgendorCrmClient, 'updateOrganization' | 'updatePerson' | 'updateDeal' | 'updateDealStage'>;
  repository: AsyncRepository;
  basis: PlanBasis;
  requestId: string;
  accountKey: 'elotenant';
  catalog: CatalogSnapshot;
  mutations: CrmMutationClient;
  reads: ReconciliationReads;
  /** Canonical source, CRM and current policy reads; fail closed on missing evidence. */
  verify(command: MutationCommand, phase: 'before' | 'after', operation: ExecutionOperation): Promise<string[]>;
  signal?: AbortSignal;
  defer?: boolean;
}
function expired(operation: ExecutionOperation) {
  const authorization = operation.input.authorization; const until = Date.parse(authorization.validUntil);
  return !authorization.actor.expiresAt || until <= Date.now() || authorization.actor.expiresAt <= Date.now() || until > authorization.actor.expiresAt || until > operation.authorizedAt + 300_000;
}
async function dispatch(ledger: ExecutionCommand, deps: ExecutionDeps): Promise<MutationOutcome> {
  const c = ledger.command; const target = await resolvedTarget(c, ledger.operationId, deps.repository);
  switch (c.kind) {
    case 'legacy_update_organization': case 'legacy_update_person': case 'legacy_update_deal': case 'legacy_update_stage': {
      if (!deps.legacy) throw Error('LEGACY_ADAPTER_UNAVAILABLE');
      const method = { legacy_update_organization: 'updateOrganization', legacy_update_person: 'updatePerson', legacy_update_deal: 'updateDeal', legacy_update_stage: 'updateDealStage' } as const;
      const result = await deps.legacy[method[c.kind]](c.target.id, c.patch);
      return { state: 'confirmed', ref: { kind: c.target.kind, id: result.id }, returnedFields: c.patch };
    }
    case 'create_organization': return deps.mutations.createOrganization(c.payload);
    case 'create_person': return deps.mutations.createPerson({ ...c.payload, ...(target ? { organization: target.id } : {}) });
    case 'create_deal': if (!target || target.kind === 'deal' || target.kind === 'task') throw Error('DEPENDENCY_NOT_CONFIRMED'); return deps.mutations.createDeal({ kind: target.kind, id: target.id }, c.payload);
    case 'create_task': if (!target || target.kind === 'task') throw Error('DEPENDENCY_NOT_CONFIRMED'); return deps.mutations.createTask({ kind: target.kind, id: target.id }, c.payload);
    case 'enrich_organization': return deps.mutations.enrichOrganization(c.target.id, c.patch);
    case 'enrich_person': return deps.mutations.enrichPerson(c.target.id, c.patch);
    case 'enrich_deal': return deps.mutations.enrichDeal(c.target.id, c.patch);
    case 'update_task': return deps.mutations.updateTask(c.target.id, c.patch);
    case 'change_stage': if (!target || target.kind !== 'deal') throw Error('DEPENDENCY_NOT_CONFIRMED'); return deps.mutations.changeStage(target.id, c.patch);
  }
}
function receipt(ledger: ExecutionCommand, state: OperationReceipt['state']): OperationReceipt {
  return { operationId: ledger.operationId, commandKey: ledger.command.commandKey, state, updatedFields: [] };
}
async function status(operation: ExecutionOperation, deps: ExecutionDeps, state: OperationStatus['state'], pendingReasons: string[] = []): Promise<OperationStatus> {
  return deps.repository.setOperationStatus(operation.operationId, { operationId: operation.operationId, state, receipts: [], pendingReasons });
}

/** Interactive calls and Queue redelivery share durable attempt claims. Only a
 * known rejection (429) can be retried. Unknown transport results never resend. */
export async function runPlan(raw: AuthorizedPlan, deps: ExecutionDeps): Promise<OperationStatus> {
  const authorization = authorizedPlanSchema.parse(raw);
  if (deps.basis.lease.mode !== 'apply') throw Error('PREVIEW_APPLY_REJECTED');
  const operation = await deps.repository.prepareOperation({ requestId: deps.requestId, accountKey: deps.accountKey, basis: deps.basis, catalogJson: JSON.stringify(deps.catalog), authorization });
  return resumeOperation(operation, deps);
}
export async function resumeOperation(operation: ExecutionOperation, deps: ExecutionDeps): Promise<OperationStatus> {
  if (operation.status.state === 'applied') return operation.status;
  for (const command of operation.input.authorization.plan.orderedCommands) {
    let ledger = await deps.repository.getExecutionCommand(command.commandKey);
    if (!ledger) {
      if (expired(operation)) return status(operation, deps, 'authorization_expired', ['AUTHORIZATION_EXPIRED']);
      ledger = await deps.repository.reserveExecutionCommand(operation.operationId, command.commandKey);
    }
    if (ledger.operationId !== operation.operationId) return status(operation, deps, 'review', ['COMMAND_OWNED_BY_OTHER_OPERATION']);
    if (ledger.state === 'confirmed') continue;
    if (ledger.state === 'review') return status(operation, deps, 'review', ['COMMAND_REQUIRES_REVIEW']);
    // sending can be a concurrent live call or a crash. Both are protected from
    // redispatch. Read-only reconciliation on a later delivery may resolve it.
    if (ledger.state === 'sending' && ledger.nextAttemptAt > Date.now()) return status(operation, deps, 'uncertain', ['DISPATCH_IN_PROGRESS_OR_UNCERTAIN']);
    if (ledger.state === 'uncertain' || ledger.state === 'sending') {
      const reconciled = await reconcileCommand(command.commandKey, deps);
      if (reconciled.state === 'confirmed') continue;
      return status(operation, deps, reconciled.state, reconciled.reviewReasons);
    }
    if (expired(operation)) return status(operation, deps, 'authorization_expired', ['AUTHORIZATION_EXPIRED']);
    if (deps.signal?.aborted) return status(operation, deps, 'review', ['CANCELLED_BEFORE_DISPATCH']);
    if (deps.defer) continue;
    if (ledger.nextAttemptAt > Date.now()) return status(operation, deps, 'queued', ['RETRY_DELAY']);
    let reasons: string[];
    try { reasons = await deps.verify(command, 'before', operation); }
    catch { return status(operation, deps, 'queued', ['CANONICAL_READ_DEFERRED']); }
    if (reasons.length) return status(operation, deps, 'review', reasons);
    if (expired(operation)) return status(operation, deps, 'authorization_expired', ['AUTHORIZATION_EXPIRED']);
    if (deps.signal?.aborted) return status(operation, deps, 'review', ['CANCELLED_BEFORE_DISPATCH']);
    let sending: ExecutionCommand | undefined;
    try { sending = await deps.repository.beginDispatch(operation.operationId, command.commandKey); }
    catch (error) {
      const code = error instanceof Error ? error.message : '';
      return status(operation, deps, code.includes('AUTHORIZATION_EXPIRED') ? 'authorization_expired' : 'review', [code.includes('AUTHORIZATION_EXPIRED') ? 'AUTHORIZATION_EXPIRED' : 'STATE_CHANGED_BEFORE_DISPATCH']);
    }
    if (!sending) return status(operation, deps, 'queued', ['COMMAND_BUSY_OR_RETRY_DELAY']);
    let outcome: MutationOutcome;
    try { outcome = await dispatch(sending, deps); }
    catch (error) {
      // Adapter throws occur before sending. Only its explicit rate-limit
      // failure is known safe; arbitrary throws may represent a process loss.
      const safe = safeError(error);
      outcome = safe.code === 'UPSTREAM_RATE_LIMITED' ? { state: 'rejected', code: safe.code, retryAfterSeconds: safe.retryAfterSeconds } : { state: 'uncertain', reason: 'UPSTREAM_UNAVAILABLE' };
    }
    if (outcome.state === 'rejected' && outcome.code === 'UPSTREAM_RATE_LIMITED') {
      const delay = Math.max(0, outcome.retryAfterSeconds ?? Math.min(300, 10 * 2 ** (sending.attempts - 1)));
      await deps.repository.finishDispatch(command.commandKey, sending.token!, { state: 'retry', receipt: receipt(sending, 'reserved'), retryAt: Date.now() + delay * 1000 });
      return status(operation, deps, sending.attempts >= 5 ? 'review' : 'queued', [sending.attempts >= 5 ? 'ATTEMPTS_EXHAUSTED' : 'UPSTREAM_RATE_LIMITED']);
    }
    if (outcome.state !== 'confirmed') {
      await deps.repository.finishDispatch(command.commandKey, sending.token!, { state: outcome.state === 'uncertain' ? 'uncertain' : 'review', receipt: receipt(sending, outcome.state === 'uncertain' ? 'uncertain' : 'rejected') });
      return status(operation, deps, outcome.state === 'uncertain' ? 'uncertain' : 'review', [outcome.state === 'uncertain' ? 'UPSTREAM_EFFECT_UNCERTAIN' : 'UPSTREAM_REJECTED']);
    }
    let checked: OperationReceipt | undefined;
    try { checked = await checkedReceipt(sending, outcome.ref, deps); reasons = await deps.verify(command, 'after', operation); }
    catch { reasons = ['POST_WRITE_READ_DEFERRED']; }
    if (deps.signal?.aborted) { checked = undefined; reasons = ['CANCELLED_AFTER_DISPATCH']; }
    await deps.repository.finishDispatch(command.commandKey, sending.token!, { state: checked && !reasons.length ? 'confirmed' : reasons.length && checked ? 'review' : 'uncertain', receipt: checked && !reasons.length ? checked : { ...receipt(sending, 'uncertain'), crmRef: outcome.ref } });
    if (reasons.length || !checked) return status(operation, deps, checked ? 'review' : 'uncertain', reasons.length ? reasons : ['READ_BACK_MISMATCH']);
  }
  return status(operation, deps, deps.defer ? 'queued' : 'applied');
}
