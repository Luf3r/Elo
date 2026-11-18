import type {
  CommandCompletion,
  CommandReservation,
  ContextProjection,
  CustomerContext,
  DemandRecord,
  OperationReceipt,
  PlanBasis,
  ReservationResult,
  ReserveWorkInput,
  SnapshotManifest,
  SyncPlan,
  WorkLease,
} from '../types';
import {
  commandCompletionSchema,
  commandReservationSchema,
  contextProjectionSchema,
  customerContextSchema,
  demandRecordSchema,
  reserveWorkInputSchema,
  snapshotManifestSchema,
  planBasisSchema,
  syncPlanSchema,
  workLeaseSchema,
} from '../schemas';
import { contextEvidenceRefs, contextValue, renderCustomerContext } from '../context/render';
import { SafeError } from '../../shared/errors';
import type { AgentAnalysis, CustomerCandidates, CatalogSnapshot, ResolutionBundle, SourceRef } from '../types';
import { createAnalysisInputSchema, customerCandidatesSchema, resolutionBundleSchema } from '../schemas';
import { resolveCustomer, uniqueSources, normalizedPhone } from '../../domain/identity';
import { resolveDemands } from '../../domain/demands';
import { OperationsStore } from '../operations';
import type { OperationInput } from '../operations';
import { automationPolicySchema } from '../../domain/policy-types';
import type { WorkflowState, WorkflowReview, ListReviewsInput } from '../service-state';
import type { AutomationPolicy } from '../types';
import { reviewResolutionInputSchema } from '../schemas';
import { WATCHDOG_INTERVAL_MS } from '../maintenance';
import type { ExecutionCommand, ExecutionOperation } from '../operations';
import { applyReviewDecision } from '../../domain/reviews';
import { canonical } from '../../shared/canonical';
import { discoveryCursorMs, type DiscoveryCursor, type PendingActivity } from '../discovery';

export const EVIDENCE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('');
}
type WorkRow = {
  work_id: string;
  digest: string;
  target_key: string;
  lease: string;
  expires_at: number;
  fence: number;
};
type CommandRow = {
  command_key: string;
  operation_id: string;
  work_id: string;
  digest: string;
  fence: number;
  version: number;
  state: OperationReceipt['state'];
  receipt: string;
};
/** Every mutation transaction below is synchronous. Hashing occurs before it; network never occurs inside it. */
export class AccountRepository {
  constructor(private readonly storage: DurableObjectStorage) {}
  private get operations() {
    return new OperationsStore(this.storage, {
      reserve: (input) => this.reserveCommand(input),
      assert: (input) => this.checkDispatch(input),
    });
  }
  async prepareOperation(input: OperationInput) {
    return this.operations.prepareOperation(input);
  }
  getOperation(id: string) {
    return this.operations.getOperation(id);
  }
  getOperationByRequest(id: string) {
    return this.operations.getOperationByRequest(id);
  }
  hasCommandKey(key: string): boolean {
    return this.sql.exec('SELECT command_key FROM commands WHERE command_key = ?', key).toArray().length > 0;
  }
  recordAudit(
    action:
      | 'review_resolved'
      | 'review_consumed'
      | 'policy_updated'
      | 'reprocess_requested'
      | 'operation_archived'
      | 'work_created'
      | 'lease_acquired'
      | 'preparation_progress'
      | 'preparation_blocked'
      | 'snapshot_persisted'
      | 'preparation_lock_acquired'
      | 'preparation_lock_released'
      | `preparation_deferred_${string}`
      | `preparation_failed_${string}`,
    targetId: string,
    version: number,
    owner: WorkLease['owner'],
    now = Date.now(),
  ): void {
    this.sql.exec(
      'INSERT INTO operational_audit VALUES (?, ?, ?, ?, ?, ?, ?)',
      crypto.randomUUID(),
      now,
      owner.userId,
      owner.clientId,
      action,
      targetId,
      version,
    );
  }
  listAudit(input: { cursor?: string; limit: number }, owner: WorkLease['owner']) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) throw Error('INVALID_AUDIT_INPUT');
    type AuditRow = { audit_id: string; occurred_at: number; action: string; target_id: string; version: number };
    let rows: AuditRow[];
    if (input.cursor) {
      const anchor = this.sql
        .exec<{ occurred_at: number }>(
          'SELECT occurred_at FROM operational_audit WHERE user_id = ? AND client_id = ? AND audit_id = ?',
          owner.userId,
          owner.clientId,
          input.cursor,
        )
        .toArray()[0];
      if (!anchor) return { entries: [] };
      rows = this.sql
        .exec<AuditRow>(
          'SELECT audit_id, occurred_at, action, target_id, version FROM operational_audit WHERE user_id = ? AND client_id = ? AND (occurred_at < ? OR (occurred_at = ? AND audit_id < ?)) ORDER BY occurred_at DESC, audit_id DESC LIMIT ?',
          owner.userId,
          owner.clientId,
          anchor.occurred_at,
          anchor.occurred_at,
          input.cursor,
          input.limit + 1,
        )
        .toArray();
    } else {
      rows = this.sql
        .exec<AuditRow>(
          'SELECT audit_id, occurred_at, action, target_id, version FROM operational_audit WHERE user_id = ? AND client_id = ? ORDER BY occurred_at DESC, audit_id DESC LIMIT ?',
          owner.userId,
          owner.clientId,
          input.limit + 1,
        )
        .toArray();
    }
    const entries = rows.slice(0, input.limit).map((r) => ({
      auditId: r.audit_id,
      occurredAt: r.occurred_at,
      action: r.action,
      targetId: r.target_id,
      version: r.version,
    }));
    return { entries, ...(rows.length > input.limit ? { cursor: entries.at(-1)!.auditId } : {}) };
  }
  recordChatHint(
    key: string,
    fingerprint: string,
    conversationId: number,
    now: number,
  ): 'accepted' | 'duplicate' | 'conflict' | 'limited' {
    if (
      !/^[a-f0-9]{64}$/.test(key) ||
      !/^[a-f0-9]{64}$/.test(fingerprint) ||
      !Number.isSafeInteger(conversationId) ||
      conversationId <= 0 ||
      !Number.isSafeInteger(now) ||
      now < 0
    )
      throw Error('INVALID_HINT');
    return this.storage.transactionSync(() => {
      const prior = this.sql
        .exec<{ digest: string }>('SELECT digest FROM chat_hints WHERE hint_key = ?', key)
        .toArray()[0];
      if (prior) return prior.digest === fingerprint ? 'duplicate' : 'conflict';
      if (
        this.sql
          .exec<{ count: number }>('SELECT COUNT(*) AS count FROM chat_hints WHERE received_at > ?', now - 60_000)
          .one().count >= 30 ||
        this.sql
          .exec<{ count: number }>('SELECT COUNT(*) AS count FROM chat_hints WHERE conversation_id IS NOT NULL')
          .one().count >= 1000
      )
        return 'limited';
      this.sql.exec('INSERT INTO chat_hints VALUES (?, ?, ?, ?)', key, conversationId, now, fingerprint);
      return 'accepted';
    });
  }
  acknowledgeChatHints(conversationId: number): void {
    this.sql.exec('UPDATE chat_hints SET conversation_id = NULL WHERE conversation_id = ?', conversationId);
  }
  getPendingCursor(cursor: string): DiscoveryCursor | undefined {
    const row = this.sql
      .exec<{ data: string }>(
        'SELECT data FROM pending_cursors WHERE cursor = ? AND expires_at > ?',
        cursor,
        Date.now(),
      )
      .toArray()[0];
    return row ? (JSON.parse(row.data) as DiscoveryCursor) : undefined;
  }
  getPendingActivity(id: string): (PendingActivity & { planId: string | null }) | undefined {
    const row = this.sql
      .exec<{ data: string; plan_id: string | null }>(
        'SELECT data, plan_id FROM pending_activity WHERE event_id = ? AND expires_at > ?',
        id,
        Date.now(),
      )
      .toArray()[0];
    return row ? { ...(JSON.parse(row.data) as PendingActivity), planId: row.plan_id } : undefined;
  }
  savePendingPage(entries: PendingActivity[], policyVersion: number, next?: DiscoveryCursor) {
    return this.storage.transactionSync(() => {
      if (this.getExecutionPolicy()?.version !== policyVersion)
        throw new SafeError('MCP_UNAUTHORIZED', 'Discovery policy changed; start a new scan.', false, 403);
      const now = Date.now();
      const pending = entries.filter((entry) => {
        const prior = this.getPendingActivity(entry.eventId);
        if (prior?.planId) return false;
        this.sql.exec(
          'INSERT INTO pending_activity VALUES (?, ?, ?, NULL) ON CONFLICT(event_id) DO UPDATE SET expires_at = excluded.expires_at, data = excluded.data',
          entry.eventId,
          now + EVIDENCE_RETENTION_MS,
          JSON.stringify(entry),
        );
        return true;
      });
      if (!next) return { entries: pending };
      this.sql.exec('DELETE FROM pending_cursors WHERE expires_at <= ?', now);
      // Bound storage even if clients repeatedly abandon cursors.
      if (this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM pending_cursors').one().count >= 1000)
        throw new SafeError(
          'UPSTREAM_RATE_LIMITED',
          'Discovery cursor capacity reached; retry after cursors expire.',
          true,
          429,
        );
      const cursor = crypto.randomUUID();
      this.sql.exec(
        'INSERT INTO pending_cursors VALUES (?, ?, ?)',
        cursor,
        next.startedAt + discoveryCursorMs,
        JSON.stringify(next),
      );
      return { entries: pending, cursor };
    });
  }
  recordDelivery(operationId: string, now: number, success: boolean): void {
    this.sql.exec(
      'UPDATE operation_delivery SET next_attempt_at = MAX(next_attempt_at, ?), failures = CASE WHEN ? THEN 0 ELSE failures + 1 END WHERE operation_id = ?',
      now + WATCHDOG_INTERVAL_MS,
      success ? 1 : 0,
      operationId,
    );
  }
  nextMaintenance(now: number): number {
    const due = this.sql
      .exec<{ deadline: number | null }>('SELECT MIN(next_attempt_at) AS deadline FROM operation_delivery')
      .one().deadline;
    return Math.max(now + 1000, Math.min(now + WATCHDOG_INTERVAL_MS, this.nextEvidenceExpiry(now), due ?? Infinity));
  }
  prepareMaintenance(now: number) {
    return this.storage.transactionSync(() => {
      const expiredEvidence = this.pruneEvidence(now);
      this.sql.exec('DELETE FROM pending_cursors WHERE expires_at <= ?', now);
      this.sql.exec('DELETE FROM pending_activity WHERE expires_at <= ?', now);
      const expired = this.sql
        .exec<{ work_id: string }>(
          'SELECT w.work_id FROM identity_reservations i JOIN work w ON w.work_id = i.work_id AND w.fence = i.fence WHERE w.expires_at <= ?',
          now,
        )
        .toArray();
      for (const work of expired) this.sql.exec('UPDATE plans SET valid = 0 WHERE work_id = ?', work.work_id);
      // Reservation rows retain their monotonically increasing fence. Deleting
      // them would allow a later work lease to reuse an old dispatch fence.
      this.sql.exec('UPDATE chat_hints SET conversation_id = NULL WHERE received_at <= ?', now - EVIDENCE_RETENTION_MS);
      const policy = this.getExecutionPolicy();
      const operations = this.sql
        .exec<{ request_id: string; digest: string; data: string }>(
          'SELECT request_id, digest, data FROM execution_operations',
        )
        .toArray();
      for (const row of operations) {
        const operation = JSON.parse(row.data) as ExecutionOperation;
        if (operation.createdAt + EVIDENCE_RETENTION_MS <= now) {
          this.sql.exec(
            'INSERT INTO execution_tombstones VALUES (?, ?, ?) ON CONFLICT(operation_id) DO NOTHING',
            operation.operationId,
            row.request_id,
            row.digest,
          );
          this.sql.exec('DELETE FROM execution_commands WHERE operation_id = ?', operation.operationId);
          this.sql.exec('DELETE FROM operation_delivery WHERE operation_id = ?', operation.operationId);
          this.sql.exec('DELETE FROM execution_operations WHERE operation_id = ?', operation.operationId);
          this.recordAudit(
            'operation_archived',
            operation.operationId,
            operation.version,
            operation.input.basis.lease.owner,
            now,
          );
          continue;
        }
        if (operation.status.state === 'applied') {
          try {
            this.publishOperationContext(operation.operationId);
          } catch {
            /* Retain pending projection for explicit reconciliation. */
          }
          continue;
        }
        if (!['queued', 'running', 'uncertain'].includes(operation.status.state)) continue;
        const commands = operation.input.authorization.plan.orderedCommands.map((c) =>
          this.operations.getExecutionCommand(c.commandKey),
        );
        const inFlight = commands.some((c) => c?.state === 'sending' || c?.state === 'uncertain');
        if (!inFlight) {
          if (
            Date.parse(operation.input.authorization.validUntil) <= now ||
            (operation.input.authorization.actor.expiresAt ?? 0) <= now ||
            (this.work(operation.input.basis.lease.workId)?.expires_at ?? 0) <= now
          ) {
            this.operations.setOperationStatus(operation.operationId, {
              operationId: operation.operationId,
              state: 'authorization_expired',
              receipts: [],
              pendingReasons: ['AUTHORIZATION_EXPIRED'],
            });
            continue;
          }
          if (
            !this.getWorkflow(operation.input.basis.lease.workId)?.direct &&
            policy &&
            (policy.mode !== 'apply' || policy.version !== operation.input.authorization.plan.policyVersion)
          ) {
            this.operations.setOperationStatus(operation.operationId, {
              operationId: operation.operationId,
              state: 'review',
              receipts: [],
              pendingReasons: ['POLICY_CHANGED'],
            });
            continue;
          }
        }
        const due = commands.reduce((deadline, command) => Math.max(deadline, command?.nextAttemptAt ?? 0), now);
        this.sql.exec(
          'INSERT INTO operation_delivery VALUES (?, ?, 0) ON CONFLICT(operation_id) DO NOTHING',
          operation.operationId,
          due,
        );
      }
      const due = this.sql
        .exec<{ operation_id: string }>(
          'SELECT operation_id FROM operation_delivery WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 50',
          now,
        )
        .toArray()
        .flatMap((row) => {
          const operation = this.operations.getOperation(row.operation_id);
          return operation ? [operation] : [];
        });
      return { expiredEvidence, expiredReservations: expired.length, due };
    });
  }
  publishOperationContext(id: string): void {
    this.storage.transactionSync(() => {
      const operation = this.operations.getOperation(id);
      if (!operation || operation.status.state !== 'applied') return;
      const basis = operation.input.basis;
      if (this.getWorkflow(basis.lease.workId)?.direct) {
        this.completeDirectOperation(id);
        return;
      }
      const current = this.sql
        .exec<{ version: number }>('SELECT version FROM contexts WHERE customer_id = ?', basis.customerId)
        .toArray()[0];
      if ((current?.version ?? 0) > basis.contextVersion) return;
      const pending = this.sql
        .exec<{ data: string | null }>(
          'SELECT data FROM facts WHERE fact_id = ? AND valid = 1',
          'customer-context:' + basis.customerId,
        )
        .toArray()[0];
      if (!pending?.data) return;
      const envelope = JSON.parse(pending.data) as { basis: PlanBasis; projection: ContextProjection };
      if (canonical(envelope.basis) !== canonical(basis)) throw Error('CONTEXT_STALE');
      for (const command of operation.input.authorization.plan.orderedCommands) {
        const receipt = this.operations.getExecutionCommand(command.commandKey)?.receipt;
        if (receipt?.state !== 'confirmed' || !receipt.checkedAt || !receipt.crmRef) continue;
        if (
          (command.kind === 'create_person' || command.kind === 'create_organization') &&
          receipt.crmRef.kind === (command.kind === 'create_person' ? 'person' : 'organization')
        ) {
          envelope.projection.primaryRef = { kind: receipt.crmRef.kind, id: receipt.crmRef.id };
          const bindingKey = `confirmed-crm:${receipt.crmRef.kind}:${receipt.crmRef.id}`;
          const bound = this.sql
            .exec<{ customer_id: string }>('SELECT customer_id FROM bindings WHERE binding_key = ?', bindingKey)
            .toArray()[0];
          if (bound && bound.customer_id !== basis.customerId) throw Error('CUSTOMER_BINDING_CONFLICT');
          this.sql.exec(
            'INSERT INTO bindings VALUES (?, ?, ?, ?) ON CONFLICT(binding_key) DO NOTHING',
            bindingKey,
            basis.customerId,
            'confirmed-crm',
            String(receipt.crmRef.id),
          );
        }
        if (command.kind === 'create_deal' && receipt.crmRef.kind === 'deal') {
          const demand = envelope.projection.demands.find((d) => command.commandKey === `deal:${d.demandId}`);
          if (demand) {
            demand.dealRef = { kind: 'deal', id: receipt.crmRef.id };
            this.sql.exec(
              'UPDATE demands SET data = ? WHERE demand_id = ? AND customer_id = ?',
              JSON.stringify(demand),
              demand.demandId,
              basis.customerId,
            );
          }
        }
      }
      envelope.projection.pendingPlanIds = (envelope.projection.pendingPlanIds ?? []).filter(
        (planId) => planId !== operation.input.authorization.plan.planId,
      );
      this.sql.exec(
        'UPDATE facts SET data = ? WHERE fact_id = ?',
        JSON.stringify(envelope),
        'customer-context:' + basis.customerId,
      );
      this.refreshCustomerContext(basis.customerId, basis.contextVersion, true);
    });
  }
  completeDirectOperation(id: string): void {
    const operation = this.operations.getOperation(id);
    if (
      !operation ||
      operation.status.state !== 'applied' ||
      !this.getWorkflow(operation.input.basis.lease.workId)?.direct
    )
      return;
    this.sql.exec(
      'UPDATE work SET expires_at = ? WHERE work_id = ? AND fence = ?',
      Date.now(),
      operation.input.basis.lease.workId,
      operation.input.basis.lease.fence,
    );
  }
  async reserveExecutionCommand(id: string, key: string) {
    return this.operations.reserveExecutionCommand(id, key);
  }
  getExecutionCommand(key: string) {
    return this.operations.getExecutionCommand(key);
  }
  beginDispatch(id: string, key: string) {
    return this.operations.beginDispatch(id, key);
  }
  finishDispatch(...args: Parameters<OperationsStore['finishDispatch']>) {
    return this.operations.finishDispatch(...args);
  }
  settleReconciliation(...args: Parameters<OperationsStore['settleReconciliation']>) {
    return this.operations.settleReconciliation(...args);
  }
  setOperationStatus(...args: Parameters<OperationsStore['setOperationStatus']>) {
    return this.storage.transactionSync(() => {
      const status = this.operations.setOperationStatus(...args);
      const operation = this.operations.getOperation(args[0]);
      if (operation && (status.state === 'review' || status.state === 'authorization_expired'))
        this.putReview({
          reviewId: 'operation-review:' + operation.operationId,
          workId: operation.input.basis.lease.workId,
          customerId: operation.input.basis.customerId,
          version: 1,
          owner: operation.input.basis.lease.owner,
          state: 'open',
          reasons: status.pendingReasons.length ? status.pendingReasons : ['COMMAND_REQUIRES_REVIEW'],
        });
      return status;
    });
  }
  getExecutionPolicy() {
    const row = this.sql.exec<{ data: string }>('SELECT data FROM policy WHERE singleton = 1').toArray()[0];
    return row ? automationPolicySchema.parse(JSON.parse(row.data)) : undefined;
  }
  private get sql() {
    return this.storage.sql;
  }
  getWorkflow(workId: string): WorkflowState | undefined {
    const row = this.sql
      .exec<{ data: string | null; evidence_expires_at: number }>(
        'SELECT data, evidence_expires_at FROM events WHERE event_id = ?',
        'workflow:' + workId,
      )
      .toArray()[0];
    if (!row?.data || row.evidence_expires_at <= Date.now()) return;
    return JSON.parse(row.data) as WorkflowState;
  }
  saveWorkflow(state: WorkflowState, expectedRevision: number): void {
    this.storage.transactionSync(() => {
      this.writeWorkflow(state, expectedRevision);
      if (state.discoveryId && state.discoveryPlanId) {
        const event = this.getPendingActivity(state.discoveryId);
        const plan = this.getServicePlan(state.discoveryPlanId);
        if (
          !event ||
          (event.planId && event.planId !== state.discoveryPlanId) ||
          !plan ||
          plan.plan.workId !== state.lease.workId ||
          !state.analysis
        )
          throw Error('PENDING_ACTIVITY_CONFLICT');
        this.sql.exec(
          'UPDATE pending_activity SET plan_id = ? WHERE event_id = ?',
          state.discoveryPlanId,
          state.discoveryId,
        );
      }
    });
  }
  private writeWorkflow(state: WorkflowState, expectedRevision: number): void {
    this.checkLease(state.lease);
    const prior = this.getWorkflow(state.lease.workId);
    if ((prior?.revision ?? 0) !== expectedRevision || state.revision !== expectedRevision + 1)
      throw Error('STATE_VERSION_CONFLICT');
    this.sql.exec(
      'INSERT INTO events VALUES (?, ?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET data = excluded.data, evidence_expires_at = excluded.evidence_expires_at',
      'workflow:' + state.lease.workId,
      'workflow',
      JSON.stringify(state),
      Date.now() + EVIDENCE_RETENTION_MS,
    );
    if (!prior) this.recordAudit('work_created', state.lease.workId, state.lease.fence, state.lease.owner);
    else if (state.step !== prior.step)
      this.recordAudit('preparation_progress', state.lease.workId, state.step, state.lease.owner);
    if (
      state.preparationDeferral &&
      JSON.stringify(state.preparationDeferral) !== JSON.stringify(prior?.preparationDeferral)
    ) {
      const d = state.preparationDeferral;
      this.recordAudit(`preparation_deferred_${d.reason}`, state.lease.workId, d.attempts, state.lease.owner);
      if (d.blocked) this.recordAudit('preparation_blocked', state.lease.workId, d.attempts, state.lease.owner);
    }
  }
  getServicePlan(planId: string): { plan: SyncPlan; workflow: WorkflowState } | undefined {
    const row = this.sql
      .exec<{ work_id: string; data: string | null; evidence_expires_at: number; valid: number }>(
        'SELECT work_id, data, evidence_expires_at, valid FROM plans WHERE plan_id = ?',
        planId,
      )
      .toArray()[0];
    if (!row?.valid || !row.data || row.evidence_expires_at <= Date.now()) return;
    const workflow = this.getWorkflow(row.work_id);
    if (!workflow) return;
    return { plan: syncPlanSchema.parse(JSON.parse(row.data)), workflow };
  }
  updatePolicy(policy: AutomationPolicy, expectedVersion: number, owner?: WorkLease['owner']): AutomationPolicy {
    const valid = automationPolicySchema.parse(policy);
    return this.storage.transactionSync(() => {
      if ((this.getExecutionPolicy()?.version ?? 1) !== expectedVersion || valid.version !== expectedVersion + 1)
        throw Error('POLICY_VERSION_CONFLICT');
      this.sql.exec(
        'INSERT INTO policy VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET version = excluded.version, data = excluded.data',
        valid.version,
        JSON.stringify(valid),
      );
      this.sql.exec('UPDATE plans SET valid = 0');
      if (owner) this.recordAudit('policy_updated', 'policy', valid.version, owner);
      return valid;
    });
  }
  putReview(review: WorkflowReview): void {
    this.sql.exec(
      'INSERT INTO reviews VALUES (?, ?, ?, ?, ?) ON CONFLICT(review_id) DO NOTHING',
      review.reviewId,
      review.workId,
      review.version,
      JSON.stringify(review),
      Date.now() + EVIDENCE_RETENTION_MS,
    );
  }
  listReviews(input: ListReviewsInput, owner: WorkLease['owner']) {
    const rows = this.sql
      .exec<{ data: string }>(
        'SELECT data FROM reviews WHERE data IS NOT NULL AND evidence_expires_at > ? AND review_id > ? ORDER BY review_id',
        Date.now(),
        input.cursor ?? '',
      )
      .toArray();
    const selected = rows
      .map((r) => JSON.parse(r.data) as WorkflowReview)
      .filter(
        (r) =>
          r.state === 'open' &&
          r.owner.userId === owner.userId &&
          r.owner.clientId === owner.clientId &&
          (!input.customerId || r.customerId === input.customerId),
      );
    const reviews = selected.slice(0, input.limit);
    const hints = input.customerId
      ? []
      : this.sql
          .exec<{ hint_key: string; conversation_id: number }>(
            'SELECT hint_key, conversation_id FROM chat_hints WHERE conversation_id IS NOT NULL AND hint_key > ? ORDER BY hint_key LIMIT ?',
            input.hintCursor ?? '',
            input.limit + 1,
          )
          .toArray();
    const chatHints = hints
      .slice(0, input.limit)
      .map((h) => ({ hintId: h.hint_key, conversationId: h.conversation_id, requiresCanonicalRead: true as const }));
    return {
      reviews,
      chatHints,
      ...(hints.length > input.limit ? { hintCursor: chatHints.at(-1)!.hintId } : {}),
      ...(selected.length > input.limit ? { cursor: reviews.at(-1)!.reviewId } : {}),
    };
  }
  resolveReview(raw: unknown, owner: WorkLease['owner']): WorkflowReview {
    const input = reviewResolutionInputSchema.parse(raw);
    return this.storage.transactionSync(() => {
      const row = this.sql
        .exec<{ data: string | null; evidence_expires_at: number }>(
          'SELECT data, evidence_expires_at FROM reviews WHERE review_id = ?',
          input.reviewId,
        )
        .toArray()[0];
      if (!row?.data || row.evidence_expires_at <= Date.now()) throw Error('REVIEW_UNAVAILABLE');
      const review = JSON.parse(row.data) as WorkflowReview;
      if (
        review.owner.userId !== owner.userId ||
        review.owner.clientId !== owner.clientId ||
        review.version !== input.expectedVersion ||
        review.state !== 'open'
      )
        throw Error('REVIEW_VERSION_CONFLICT');
      const decision = input.decision;
      if (decision.kind === 'approvePlan') {
        const plan = this.sql
          .exec<{ work_id: string; version: number; data: string | null; evidence_expires_at: number }>(
            'SELECT work_id, version, data, evidence_expires_at FROM plans WHERE plan_id = ?',
            decision.planId,
          )
          .toArray()[0];
        if (
          !plan?.data ||
          plan.work_id !== review.workId ||
          plan.version !== decision.planVersion ||
          plan.evidence_expires_at <= Date.now()
        )
          throw Error('PLAN_STALE');
      }
      if (
        decision.kind === 'selectDemand' &&
        !this.sql
          .exec(
            'SELECT demand_id FROM demands WHERE demand_id = ? AND customer_id = ? AND data IS NOT NULL AND evidence_expires_at > ?',
            decision.demandId,
            review.customerId,
            Date.now(),
          )
          .toArray().length
      )
        throw Error('DEMAND_UNAVAILABLE');
      if (decision.kind === 'selectCustomer' || decision.kind === 'correctFacts') {
        const manifest = this.sql
          .exec<{ data: string | null; evidence_expires_at: number }>(
            'SELECT data, evidence_expires_at FROM snapshot_manifest WHERE work_id = ?',
            review.workId,
          )
          .toArray()[0];
        if (!manifest?.data || manifest.evidence_expires_at <= Date.now()) throw Error('SNAPSHOT_REQUIRED');
        const snapshot = snapshotManifestSchema.parse(JSON.parse(manifest.data));
        if (
          decision.kind === 'selectCustomer' &&
          !snapshot.records.some((r) => canonical(r.ref) === canonical(decision.ref))
        )
          throw Error('CANDIDATE_ABSENT_FROM_SNAPSHOT');
        if (
          decision.kind === 'correctFacts' &&
          decision.facts.some((f) =>
            f.sources.some((ref) => !snapshot.sources.some((s) => canonical(s) === canonical(ref))),
          )
        )
          throw Error('STALE_SOURCE');
      }
      // A decision invalidates the old plan. A fresh preparation and analysis
      // must bind any corrected facts/selection to current sources before apply.
      const resolved: WorkflowReview = {
        ...review,
        state: 'resolved',
        version: review.version + 1,
        decision: input.decision,
      };
      if (decision.kind !== 'reject') {
        const workflow = this.getWorkflow(review.workId);
        if (
          !workflow?.work ||
          !workflow.analysis ||
          !workflow.basis ||
          workflow.direct ||
          workflow.customerId !== review.customerId ||
          workflow.lease.owner.userId !== owner.userId ||
          workflow.lease.owner.clientId !== owner.clientId
        )
          throw Error('REVIEW_WORK_UNAVAILABLE');
        if (review.snapshotVersion !== undefined && review.snapshotVersion !== workflow.work.snapshotVersion)
          throw Error('REVIEW_VERSION_CONFLICT');
        if (decision.kind === 'approvePlan') {
          const plan = this.sql
            .exec<{ snapshot_version: number }>('SELECT snapshot_version FROM plans WHERE plan_id = ?', decision.planId)
            .toArray()[0];
          if (plan?.snapshot_version !== workflow.work.snapshotVersion) throw Error('PLAN_STALE');
        }
        if (decision.kind === 'selectDemand' && workflow.analysis.demands.length !== 1)
          throw Error('REVIEW_DEMAND_SCOPE_INVALID');
        const manifest = this.sql
          .exec<{ data: string | null }>('SELECT data FROM snapshot_manifest WHERE work_id = ?', review.workId)
          .toArray()[0];
        if (!manifest?.data) throw Error('SNAPSHOT_REQUIRED');
        workflow.pendingReview = {
          reviewId: review.reviewId,
          version: resolved.version,
          sourceSnapshotVersion: workflow.work.snapshotVersion,
          sourceRefs: snapshotManifestSchema.parse(JSON.parse(manifest.data)).sources,
          analysis: workflow.analysis,
          policyVersion: this.getExecutionPolicy()?.version ?? 1,
          decision,
          ...(decision.kind === 'selectDemand' ? { clientKey: workflow.analysis.demands[0]!.clientKey } : {}),
        };
        workflow.snapshotVersion = workflow.work.snapshotVersion + 1;
        workflow.revision++;
        workflow.step = 0;
        workflow.pages = [];
        workflow.conversations = [];
        workflow.continuation = crypto.randomUUID();
        delete workflow.verificationPass;
        delete workflow.verificationReads;
        delete workflow.candidateReadCache;
        delete workflow.work;
        delete workflow.catalog;
        delete workflow.basis;
        delete workflow.analysis;
        delete workflow.hydration;
        this.sql.exec(
          'UPDATE events SET data = ? WHERE event_id = ?',
          JSON.stringify(workflow),
          'workflow:' + review.workId,
        );
        // Discard only unpublished projections from the old reviewed snapshot.
        this.sql.exec(
          'UPDATE facts SET valid = 0 WHERE work_id = ? AND version > COALESCE((SELECT version FROM contexts WHERE customer_id = ?), 0)',
          review.workId,
          review.customerId,
        );
      }
      this.sql.exec(
        'UPDATE reviews SET data = ?, version = ? WHERE review_id = ?',
        JSON.stringify(resolved),
        resolved.version,
        review.reviewId,
      );
      this.sql.exec('UPDATE plans SET valid = 0 WHERE work_id = ?', review.workId);
      this.recordAudit('review_resolved', review.reviewId, resolved.version, owner);
      return resolved;
    });
  }
  private activeReview(basis: PlanBasis) {
    const workflow = this.getWorkflow(basis.lease.workId);
    const pending = workflow?.pendingReview;
    if (!pending) return;
    if (workflow.customerId !== basis.customerId || basis.snapshotVersion !== pending.sourceSnapshotVersion + 1)
      throw Error('REVIEW_SCOPE_CHANGED');
    const row = this.sql
      .exec<{ data: string | null; evidence_expires_at: number }>(
        'SELECT data, evidence_expires_at FROM reviews WHERE review_id = ?',
        pending.reviewId,
      )
      .toArray()[0];
    if (!row?.data || row.evidence_expires_at <= Date.now()) throw Error('REVIEW_UNAVAILABLE');
    const review = JSON.parse(row.data) as WorkflowReview;
    if (
      review.workId !== basis.lease.workId ||
      review.customerId !== basis.customerId ||
      canonical(review.owner) !== canonical(basis.lease.owner) ||
      review.state !== 'resolved' ||
      canonical(review.decision) !== canonical(pending.decision) ||
      review.version !== pending.version + (review.consumedBy ? 1 : 0) ||
      (review.consumedBy && review.consumedBy.snapshotVersion !== basis.snapshotVersion)
    )
      throw Error('REVIEW_VERSION_CONFLICT');
    const manifest = this.checkBasis(basis);
    if (pending.sourceRefs.some((ref) => !manifest.sources.some((source) => canonical(source) === canonical(ref))))
      throw Error('REVIEW_SOURCE_CHANGED');
    if (pending.decision.kind === 'approvePlan' && (this.getExecutionPolicy()?.version ?? 1) !== pending.policyVersion)
      throw Error('REVIEW_POLICY_CHANGED');
    return { pending, review };
  }
  reviewAnalysis(raw: AgentAnalysis, basis: PlanBasis): AgentAnalysis {
    const active = this.activeReview(basis);
    return active ? applyReviewDecision(raw, active.pending) : raw;
  }
  getServiceStatus(owner: WorkLease['owner']) {
    const policy = this.getExecutionPolicy();
    const pendingReviews = this.listReviews({ limit: 100 }, owner).reviews.length;
    const pendingOperations = this.sql
      .exec<{ data: string }>('SELECT data FROM execution_operations')
      .toArray()
      .map((r) => JSON.parse(r.data) as import('../operations').ExecutionOperation)
      .filter(
        (o) =>
          o.input.authorization.actor.userId === owner.userId &&
          o.input.authorization.actor.clientId === owner.clientId &&
          ['queued', 'running', 'uncertain'].includes(o.status.state),
      ).length;
    const workflows = this.sql
      .exec<{ data: string }>(
        "SELECT e.data FROM events e JOIN work w ON e.event_id = 'workflow:' || w.work_id JOIN identity_reservations i ON i.work_id = w.work_id AND i.fence = w.fence WHERE e.data IS NOT NULL AND e.evidence_expires_at > ?",
        Date.now(),
      )
      .toArray()
      .map((r) => JSON.parse(r.data) as WorkflowState)
      .filter((w) => w.lease.owner.userId === owner.userId && w.lease.owner.clientId === owner.clientId);
    const active = workflows.filter((w) => Date.parse(w.lease.expiresAt) > Date.now());
    const awaitingAgent = active.filter((w) => !w.direct && !!w.work && !w.analysis).length;
    const preparing = active.filter((w) => !w.direct && !w.work && !w.preparationDeferral?.blocked).length;
    const blockedWork = active.filter((w) => !w.direct && !!w.preparationDeferral?.blocked).length;
    const expiredWork = workflows.filter(
      (w) => !w.direct && !w.analysis && Date.parse(w.lease.expiresAt) <= Date.now(),
    ).length;
    const incompleteCoverage = active.filter((w) => w.work && !w.work.coverage.complete).length;
    const pendingHints = this.sql
      .exec<{ count: number }>('SELECT COUNT(*) AS count FROM chat_hints WHERE conversation_id IS NOT NULL')
      .one().count;
    return {
      mode: policy?.mode ?? ('disabled' as const),
      policyVersion: policy?.version ?? 1,
      pendingReviews,
      pendingOperations,
      state:
        !policy || policy.mode === 'disabled'
          ? ('paused' as const)
          : pendingReviews || incompleteCoverage || pendingHints || blockedWork || expiredWork
            ? ('degraded' as const)
            : ('ready' as const),
      awaitingAgent,
      preparing,
      blockedWork,
      expiredWork,
      incompleteCoverage,
      pendingHints,
    };
  }
  private work(id: string): WorkRow | undefined {
    return this.sql.exec<WorkRow>('SELECT * FROM work WHERE work_id = ?', id).toArray()[0];
  }
  private liveWork(id: string): WorkRow {
    const row = this.work(id);
    if (!row || row.expires_at <= Date.now()) throw Error('LEASE_EXPIRED');
    const owner = this.sql
      .exec<{ fence: number }>('SELECT fence FROM identity_reservations WHERE target_key = ?', row.target_key)
      .toArray()[0];
    if (owner?.fence !== row.fence) throw Error('LEASE_FENCED');
    return row;
  }
  private checkLease(lease: WorkLease): WorkRow {
    const row = this.liveWork(lease.workId);
    if (canonical(JSON.parse(row.lease)) !== canonical(lease)) throw Error('LEASE_FENCED');
    return row;
  }
  beginPreparation(lease: WorkLease): string {
    return this.storage.transactionSync(() => {
      this.checkLease(lease);
      const now = Date.now();
      const existing = this.sql
        .exec<{ expires_at: number }>('SELECT expires_at FROM preparation_locks WHERE work_id = ?', lease.workId)
        .toArray()[0];
      if (existing && existing.expires_at > now)
        throw new SafeError(
          'UPSTREAM_CONFLICT',
          'Preparation already running; retry after the current call finishes.',
          true,
          409,
          undefined,
          2,
        );
      const holder = crypto.randomUUID();
      this.sql.exec(
        'INSERT INTO preparation_locks VALUES (?, ?, ?) ON CONFLICT(work_id) DO UPDATE SET holder=excluded.holder, expires_at=excluded.expires_at',
        lease.workId,
        holder,
        Math.min(now + 60_000, Date.parse(lease.expiresAt)),
      );
      this.recordAudit('preparation_lock_acquired', lease.workId, lease.fence, lease.owner);
      return holder;
    });
  }
  renewPreparation(lease: WorkLease, holder: string): void {
    this.storage.transactionSync(() => {
      this.checkLease(lease);
      const now = Date.now();
      const lock = this.sql
        .exec<{ holder: string; expires_at: number }>(
          'SELECT holder, expires_at FROM preparation_locks WHERE work_id = ?',
          lease.workId,
        )
        .toArray()[0];
      if (!lock || lock.holder !== holder || lock.expires_at <= now)
        throw new SafeError(
          'UPSTREAM_CONFLICT',
          'Preparation lock expired; retry with the same work.',
          true,
          409,
          undefined,
          2,
        );
      this.sql.exec(
        'UPDATE preparation_locks SET expires_at = ? WHERE work_id = ? AND holder = ?',
        Math.min(now + 60_000, Date.parse(lease.expiresAt)),
        lease.workId,
        holder,
      );
    });
  }
  endPreparation(lease: WorkLease, holder: string): void {
    this.storage.transactionSync(() => {
      const existing = this.sql
        .exec<{ holder: string }>('SELECT holder FROM preparation_locks WHERE work_id = ?', lease.workId)
        .toArray()[0];
      if (existing?.holder !== holder) return;
      this.sql.exec('DELETE FROM preparation_locks WHERE work_id = ? AND holder = ?', lease.workId, holder);
      this.recordAudit('preparation_lock_released', lease.workId, lease.fence, lease.owner);
    });
  }
  private checkBasis(basis: PlanBasis, allowExpired = false): SnapshotManifest {
    if (allowExpired) {
      const work = this.work(basis.lease.workId);
      if (!work || canonical(JSON.parse(work.lease)) !== canonical(basis.lease)) throw Error('LEASE_FENCED');
    } else this.checkLease(basis.lease);
    const row = this.sql
      .exec<{ data: string | null; evidence_expires_at: number }>(
        'SELECT data, evidence_expires_at FROM snapshot_manifest WHERE work_id = ?',
        basis.lease.workId,
      )
      .toArray()[0];
    if (!row?.data || row.evidence_expires_at <= Date.now()) throw Error('SNAPSHOT_REQUIRED');
    const manifest = snapshotManifestSchema.parse(JSON.parse(row.data));
    if (
      manifest.snapshotVersion !== basis.snapshotVersion ||
      manifest.contextVersion !== basis.contextVersion ||
      manifest.catalogVersion !== basis.catalogVersion
    )
      throw Error('STATE_VERSION_CONFLICT');
    if (basis.lease.target.kind === 'customer' && basis.lease.target.customerId !== basis.customerId)
      throw Error('CONTEXT_CUSTOMER_MISMATCH');
    const customer = this.sql
      .exec<{ customer_id: string }>('SELECT customer_id FROM work_customers WHERE work_id = ?', basis.lease.workId)
      .toArray()[0];
    if (customer && customer.customer_id !== basis.customerId) throw Error('CONTEXT_CUSTOMER_MISMATCH');
    const current = this.sql
      .exec<{ version: number }>('SELECT version FROM contexts WHERE customer_id = ?', basis.customerId)
      .toArray()[0];
    if ((current?.version ?? 0) !== basis.contextVersion)
      throw new SafeError('CONTEXT_STALE', 'Customer context changed; reload and reconcile.', false, 409);
    if (!customer) this.sql.exec('INSERT INTO work_customers VALUES (?, ?)', basis.lease.workId, basis.customerId);
    return manifest;
  }
  private checkDispatch(input: CommandReservation): void {
    const authorization = input.authorization;
    const plan = authorization.plan;
    const policy = this.getExecutionPolicy();
    const direct = this.getWorkflow(input.lease.workId)?.direct;
    if (
      direct &&
      (canonical(direct.command) !== canonical(input.command) ||
        input.command.requiredCapabilities.length !== 1 ||
        input.command.requiredCapabilities[0] !== direct.capability)
    )
      throw Error('COMMAND_NOT_AUTHORIZED');
    if (
      !direct &&
      policy &&
      (policy.mode !== 'apply' ||
        policy.version !== plan.policyVersion ||
        input.command.requiredCapabilities.some((c) => !policy.capabilities.includes(c)))
    )
      throw Error('POLICY_CHANGED');
    const row = this.sql
      .exec<{
        data: string | null;
        work_id: string;
        version: number;
        valid: number;
        fence: number | null;
        snapshot_version: number | null;
        context_version: number | null;
        catalog_version: string | null;
        evidence_expires_at: number;
      }>('SELECT * FROM plans WHERE plan_id = ?', plan.planId)
      .toArray()[0];
    if (
      !row?.valid ||
      !row.data ||
      row.evidence_expires_at <= Date.now() ||
      row.work_id !== input.lease.workId ||
      row.version !== plan.version ||
      row.fence !== input.lease.fence ||
      row.snapshot_version !== input.snapshotVersion ||
      row.context_version !== input.contextVersion ||
      row.catalog_version !== input.catalogVersion ||
      canonical(JSON.parse(row.data)) !== canonical(plan)
    )
      throw Error('PLAN_STALE');
    this.checkBasis(input);
    if (
      input.lease.mode !== 'apply' ||
      plan.state !== 'ready' ||
      plan.reviewIds.length ||
      !plan.orderedCommands.some((command) => canonical(command) === canonical(input.command))
    )
      throw Error('COMMAND_NOT_AUTHORIZED');
    const actor = authorization.actor;
    const now = Date.now();
    const validUntil = Date.parse(authorization.validUntil);
    if (validUntil <= now || actor.expiresAt === undefined || actor.expiresAt <= now || validUntil > actor.expiresAt)
      throw Error('AUTHORIZATION_EXPIRED');
    const grants = authorization.commandCapabilities.find(
      (command) => command.commandKey === input.command.commandKey,
    )?.capabilities;
    if (
      actor.userId !== input.lease.owner.userId ||
      actor.clientId !== input.lease.owner.clientId ||
      (!direct && !actor.scopes.includes('automation:process')) ||
      !grants ||
      input.command.requiredCapabilities.some(
        (capability) => !grants.includes(capability) || !actor.scopes.includes(capability),
      )
    )
      throw Error('COMMAND_NOT_AUTHORIZED');
  }
  private invalidate(workId: string) {
    this.sql.exec('UPDATE plans SET valid = 0 WHERE work_id = ?', workId);
    this.sql.exec('UPDATE facts SET valid = 0 WHERE work_id = ?', workId);
    this.sql.exec('UPDATE contexts SET valid = 0 WHERE work_id = ?', workId);
  }
  activate(input: { crmAccountId: string; chatAccountId: string }): void {
    if (
      !input.crmAccountId ||
      !input.chatAccountId ||
      input.crmAccountId.length > 200 ||
      input.chatAccountId.length > 200
    )
      throw Error('INVALID_ACCOUNT_BINDING');
    this.storage.transactionSync(() => {
      const row = this.sql
        .exec<{ crm_account_id: string; chat_account_id: string }>('SELECT * FROM account_binding WHERE singleton = 1')
        .toArray()[0];
      if (row && (row.crm_account_id !== input.crmAccountId || row.chat_account_id !== input.chatAccountId))
        throw Error('ACCOUNT_RECONFIGURATION_REQUIRED');
      if (!row) this.sql.exec('INSERT INTO account_binding VALUES (1, ?, ?)', input.crmAccountId, input.chatAccountId);
    });
  }
  async reserveWork(raw: ReserveWorkInput): Promise<WorkLease> {
    const input = reserveWorkInputSchema.parse(raw);
    const fingerprint = await digest({
      target: input.target,
      mode: input.mode,
      actor: { userId: input.actor.userId, clientId: input.actor.clientId, scopes: [...input.actor.scopes].sort() },
      payloadDigest: input.payloadDigest,
    });
    const targetKey = await digest(input.target);
    return this.storage.transactionSync(() => {
      const now = Date.now();
      if (input.actor.expiresAt !== undefined && input.actor.expiresAt <= now) throw Error('AUTHORIZATION_EXPIRED');
      const previous = this.sql.exec<WorkRow>('SELECT * FROM work WHERE request_id = ?', input.requestId).toArray()[0];
      if (previous && previous.digest !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT');
      if (previous && previous.expires_at > now) return JSON.parse(previous.lease) as WorkLease;
      const identity = this.sql
        .exec<{ work_id: string; fence: number }>('SELECT * FROM identity_reservations WHERE target_key = ?', targetKey)
        .toArray()[0];
      if (identity && (this.work(identity.work_id)?.expires_at ?? 0) > now) throw Error('WORK_BUSY');
      const lease: WorkLease = {
        workId: previous?.work_id ?? crypto.randomUUID(),
        leaseToken: crypto.randomUUID(),
        owner: { userId: input.actor.userId, clientId: input.actor.clientId },
        fence: (identity?.fence ?? 0) + 1,
        expiresAt: new Date(now + 600_000).toISOString(),
        mode: input.mode,
        target: input.target,
      };
      if (identity) {
        this.invalidate(identity.work_id);
        this.sql.exec('UPDATE snapshot_manifest SET data = NULL WHERE work_id = ?', identity.work_id);
      }
      this.sql.exec(
        'INSERT INTO work VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(work_id) DO UPDATE SET lease = excluded.lease, expires_at = excluded.expires_at, fence = excluded.fence',
        lease.workId,
        input.requestId,
        fingerprint,
        targetKey,
        JSON.stringify(lease),
        now + 600_000,
        lease.fence,
      );
      this.sql.exec(
        'INSERT INTO identity_reservations VALUES (?, ?, ?) ON CONFLICT(target_key) DO UPDATE SET work_id = excluded.work_id, fence = excluded.fence',
        targetKey,
        lease.workId,
        lease.fence,
      );
      this.recordAudit('lease_acquired', lease.workId, lease.fence, lease.owner);
      return lease;
    });
  }
  getSnapshotVersion(workId: string): number {
    return (
      this.sql.exec<{ version: number }>('SELECT version FROM snapshot_manifest WHERE work_id = ?', workId).toArray()[0]
        ?.version ?? 0
    );
  }
  async installSnapshot(rawLease: WorkLease, rawManifest: SnapshotManifest, workflow?: WorkflowState): Promise<void> {
    const lease = workLeaseSchema.parse(rawLease);
    const manifest = snapshotManifestSchema.parse(rawManifest);
    if (manifest.workId !== lease.workId || (workflow && canonical(workflow.lease) !== canonical(lease)))
      throw Error('LEASE_FENCED');
    const fingerprint = await digest(manifest);
    this.storage.transactionSync(() => {
      this.checkLease(lease);
      const previous = this.sql
        .exec<{ version: number; digest: string }>(
          'SELECT version, digest FROM snapshot_manifest WHERE work_id = ?',
          lease.workId,
        )
        .toArray()[0];
      if (!workflow && previous?.version === manifest.snapshotVersion && previous.digest === fingerprint) return;
      if (manifest.snapshotVersion !== (previous?.version ?? 0) + 1) throw Error('VERSION_CONFLICT');
      if (workflow) this.writeWorkflow(workflow, workflow.revision - 1);
      this.invalidate(lease.workId);
      this.sql.exec(
        'INSERT INTO snapshot_manifest VALUES (?, ?, ?, ?, ?) ON CONFLICT(work_id) DO UPDATE SET version = excluded.version, digest = excluded.digest, data = excluded.data, evidence_expires_at = excluded.evidence_expires_at',
        lease.workId,
        manifest.snapshotVersion,
        fingerprint,
        JSON.stringify(manifest),
        Date.now() + EVIDENCE_RETENTION_MS,
      );
      this.recordAudit('snapshot_persisted', lease.workId, manifest.snapshotVersion, lease.owner);
    });
  }
  async savePlan(raw: SyncPlan, rawBasis: PlanBasis): Promise<void> {
    const plan = syncPlanSchema.parse(raw);
    const basis = planBasisSchema.parse(rawBasis);
    const fingerprint = await digest(plan);
    this.storage.transactionSync(() => {
      if (plan.workId !== basis.lease.workId) throw Error('LEASE_FENCED');
      const manifest = this.checkBasis(basis);
      const sources = manifest.sources;
      for (const ref of [
        ...plan.sourceRefs,
        ...plan.before.flatMap((f) => f.sources),
        ...plan.after.flatMap((f) => f.sources),
        ...plan.orderedCommands.flatMap((c) => [...c.sourceRefs, ...c.before.flatMap((f) => f.sources)]),
      ])
        if (!sources.some((s) => canonical(s) === canonical(ref))) throw Error('STALE_SOURCE');
      const previous = this.sql
        .exec<{
          work_id: string;
          version: number;
          digest: string;
          valid: number;
          fence: number;
          snapshot_version: number;
          context_version: number;
          catalog_version: string;
        }>('SELECT * FROM plans WHERE plan_id = ?', plan.planId)
        .toArray()[0];
      if (previous && previous.work_id !== plan.workId) throw Error('IDEMPOTENCY_CONFLICT');
      if (
        previous?.version === plan.version &&
        previous.digest === fingerprint &&
        previous.valid &&
        previous.fence === basis.lease.fence &&
        previous.snapshot_version === basis.snapshotVersion &&
        previous.context_version === basis.contextVersion &&
        previous.catalog_version === basis.catalogVersion
      )
        return;
      if (plan.version !== (previous?.version ?? 0) + 1) throw Error('VERSION_CONFLICT');
      this.sql.exec(
        'INSERT INTO plans (plan_id, work_id, version, digest, valid, data, evidence_expires_at, fence, snapshot_version, context_version, catalog_version) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?) ON CONFLICT(plan_id) DO UPDATE SET version = excluded.version, digest = excluded.digest, valid = 1, data = excluded.data, evidence_expires_at = excluded.evidence_expires_at, fence = excluded.fence, snapshot_version = excluded.snapshot_version, context_version = excluded.context_version, catalog_version = excluded.catalog_version',
        plan.planId,
        plan.workId,
        plan.version,
        fingerprint,
        JSON.stringify(plan),
        Date.now() + EVIDENCE_RETENTION_MS,
        basis.lease.fence,
        basis.snapshotVersion,
        basis.contextVersion,
        basis.catalogVersion,
      );
      const active = this.activeReview(basis);
      if (active) {
        if (active.review.consumedBy) throw Error('REVIEW_ALREADY_CONSUMED');
        active.review.consumedBy = {
          planId: plan.planId,
          planVersion: plan.version,
          snapshotVersion: basis.snapshotVersion,
        };
        active.review.version++;
        this.sql.exec(
          'UPDATE reviews SET data = ?, version = ? WHERE review_id = ? AND version = ?',
          JSON.stringify(active.review),
          active.review.version,
          active.review.reviewId,
          active.pending.version,
        );
        this.recordAudit('review_consumed', active.review.reviewId, active.review.version, basis.lease.owner);
      }
    });
  }
  /** Backend-only resolver. The caller provides a server-created PlanBasis, never an agent customer ID.
   * Reservations survive evidence cleanup and cover different conversations in this account. */
  async resolveWork(
    rawAnalysis: AgentAnalysis,
    rawCandidates: CustomerCandidates,
    catalog: CatalogSnapshot,
    rawBasis: PlanBasis,
  ): Promise<ResolutionBundle> {
    const basis = planBasisSchema.parse(rawBasis);
    const candidates = customerCandidatesSchema.parse({ ...rawCandidates, customerId: basis.customerId });
    const fingerprint = await digest({ analysis: rawAnalysis, candidates, catalogVersion: catalog.version, basis });
    const identityValues: string[] = [];
    for (const fact of rawAnalysis.facts)
      if (fact.certainty === 'confirmed' && typeof fact.value === 'string') {
        if (fact.field === 'cnpj' && fact.entity === 'organization' && fact.value.replace(/\D/g, '').length === 14)
          identityValues.push('organization:cnpj:' + fact.value.replace(/\D/g, ''));
        if (fact.field === 'email') identityValues.push(fact.entity + ':email:' + fact.value.trim().toLowerCase());
        if (fact.field === 'phone' && normalizedPhone(fact.value))
          identityValues.push('phone:' + normalizedPhone(fact.value));
      }
    if (rawAnalysis.customerSelection.kind !== 'new')
      identityValues.push(`${rawAnalysis.customerSelection.kind}:${rawAnalysis.customerSelection.id}`);
    else if (!identityValues.length)
      identityValues.push(
        `${rawAnalysis.customerSelection.entity}:name-reservation:${rawAnalysis.customerSelection.record.name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR')}`,
      );
    const identities = await Promise.all([...new Set(identityValues)].sort().map((value) => digest(value)));
    return this.storage.transactionSync(() => {
      const manifest = this.checkBasis(basis);
      if (catalog.version !== basis.catalogVersion) throw Error('STATE_VERSION_CONFLICT');
      const eventId = `resolution:${basis.lease.workId}:${basis.snapshotVersion}`;
      const previous = this.sql
        .exec<{ digest: string; data: string | null; evidence_expires_at: number }>(
          'SELECT digest, data, evidence_expires_at FROM events WHERE event_id = ?',
          eventId,
        )
        .toArray()[0];
      if (previous) {
        if (previous.digest !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT');
        if (!previous.data || previous.evidence_expires_at <= Date.now()) throw Error('RESOLUTION_EVIDENCE_EXPIRED');
        return resolutionBundleSchema.parse(JSON.parse(previous.data));
      }
      const existing = this.sql
        .exec<{ data: string | null; evidence_expires_at: number }>(
          'SELECT data, evidence_expires_at FROM demands WHERE customer_id = ?',
          basis.customerId,
        )
        .toArray()
        .filter((r) => r.data && r.evidence_expires_at > Date.now())
        .map((r) => demandRecordSchema.parse(JSON.parse(r.data!)));
      const validation = createAnalysisInputSchema({
        sourceRefs: manifest.sources.filter(
          (s): s is SourceRef & { kind: 'message' | 'contact' | 'crm' } => s.kind !== 'operator',
        ),
        candidates: candidates.candidates.map((c) => c.ref),
        existingDemandIds: existing.map((d) => d.demandId),
        catalog,
      }).safeParse({
        workId: basis.lease.workId,
        leaseToken: basis.lease.leaseToken,
        expectedSnapshotVersion: basis.snapshotVersion,
        expectedContextVersion: basis.contextVersion,
        analysis: rawAnalysis,
      });
      if (!validation.success) throw Error('ANALYSIS_INVALID');
      for (const candidate of candidates.candidates)
        if (!manifest.records.some((r) => r.ref.kind === candidate.ref.kind && r.ref.id === candidate.ref.id))
          throw Error('CANDIDATE_ABSENT_FROM_SNAPSHOT');
      for (const source of uniqueSources([
        ...candidates.candidates.flatMap((c) => c.sourceRefs),
        ...(candidates.verifiedLinks ?? []).flatMap((l) => l.sourceRefs),
      ]))
        if (!manifest.sources.some((s) => canonical(s) === canonical(source))) throw Error('STALE_SOURCE');
      let customer = resolveCustomer(validation.data.analysis, candidates, catalog);
      const reviewed = this.activeReview(basis);
      if (
        reviewed &&
        canonical(rawAnalysis) !== canonical(applyReviewDecision(reviewed.pending.analysis, reviewed.pending))
      )
        throw Error('REVIEW_ANALYSIS_CHANGED');
      if (reviewed?.pending.decision.kind === 'selectCustomer') {
        const ref = reviewed.pending.decision.ref;
        const selected = candidates.candidates.find((c) => canonical(c.ref) === canonical(ref));
        if (!selected || !candidates.coverage.complete) throw Error('REVIEW_CUSTOMER_CHANGED');
        customer = {
          kind: 'resolved',
          customerId: basis.customerId,
          ref,
          sourceRefs: selected.sourceRefs,
          reviewReasons: [],
        };
      }
      if (customer.kind !== 'review') {
        const reservations = identities.flatMap((id) =>
          this.sql
            .exec<{ customer_id: string; external_id: string }>(
              'SELECT customer_id, external_id FROM bindings WHERE binding_key = ?',
              `identity:${id}`,
            )
            .toArray(),
        );
        const conflict = reservations.some((row) => row.customer_id !== basis.customerId);
        if (conflict)
          customer = {
            kind: 'review',
            sourceRefs: customer.sourceRefs,
            reviewReasons: ['IDENTITY_RESERVED_FOR_OTHER_CUSTOMER'],
          };
        else if (customer.kind === 'create' && reservations.some((row) => row.external_id !== basis.lease.workId))
          customer = { kind: 'review', sourceRefs: customer.sourceRefs, reviewReasons: ['IDENTITY_CREATION_PENDING'] };
      }
      const demands = resolveDemands(validation.data.analysis, customer, existing);
      if (reviewed?.pending.decision.kind === 'selectDemand' && customer.kind !== 'review') {
        const id = reviewed.pending.decision.demandId;
        const record = existing.find((d) => d.demandId === id && d.state === 'open');
        const request = validation.data.analysis.demands.find((d) => d.clientKey === reviewed.pending.clientKey);
        if (!record || !request) throw Error('REVIEW_DEMAND_CHANGED');
        demands.demands = demands.demands.map((d) =>
          d.clientKey === request.clientKey
            ? {
                kind: 'resolved' as const,
                clientKey: request.clientKey,
                demandId: id,
                sourceRefs: uniqueSources([
                  ...request.explicitRequest.sources,
                  ...request.approach.sources,
                  ...request.stage.sources,
                ]),
                reviewReasons: [],
              }
            : d,
        );
        demands.reviewReasons = [...new Set(demands.demands.flatMap((d) => d.reviewReasons))];
      }
      const bundle = resolutionBundleSchema.parse({ customer, demands });
      if (customer.kind !== 'review') {
        this.sql.exec('INSERT INTO customers VALUES (?, 1) ON CONFLICT(customer_id) DO NOTHING', basis.customerId);
        for (const id of identities)
          this.sql.exec(
            'INSERT INTO bindings VALUES (?, ?, ?, ?) ON CONFLICT(binding_key) DO NOTHING',
            `identity:${id}`,
            basis.customerId,
            'identity',
            basis.lease.workId,
          );
        if (customer.kind === 'resolved')
          this.sql.exec(
            'INSERT INTO bindings VALUES (?, ?, ?, ?) ON CONFLICT(binding_key) DO NOTHING',
            `confirmed-crm:${customer.ref.kind}:${customer.ref.id}`,
            basis.customerId,
            'confirmed-crm',
            String(customer.ref.id),
          );
        for (const decision of demands.demands)
          if (decision.kind === 'create' || decision.kind === 'resolved') {
            const request = validation.data.analysis.demands.find((d) => d.clientKey === decision.clientKey)!;
            const record: DemandRecord = {
              demandId: decision.demandId,
              customerId: basis.customerId,
              clientKey: request.clientKey,
              service: request.service,
              scope: request.scope,
              state: 'open',
              sourceRefs: decision.sourceRefs,
              ...(request.references ? { references: request.references } : {}),
            };
            const prior = this.sql
              .exec<{ data: string }>('SELECT data FROM demands WHERE demand_id = ?', record.demandId)
              .toArray()[0];
            if (prior) {
              const previous = demandRecordSchema.parse(JSON.parse(prior.data));
              record.dealRef = previous.dealRef;
              record.state = previous.state;
              record.references = [
                ...new Map(
                  [...(previous.references ?? []), ...(record.references ?? [])].map((r) => [
                    `${r.kind}:${r.value}`,
                    r,
                  ]),
                ).values(),
              ];
            }
            this.sql.exec(
              'INSERT INTO demands VALUES (?, ?, 1, ?, ?) ON CONFLICT(demand_id) DO UPDATE SET data = excluded.data, evidence_expires_at = excluded.evidence_expires_at',
              record.demandId,
              basis.customerId,
              JSON.stringify(record),
              Date.now() + EVIDENCE_RETENTION_MS,
            );
          }
      }
      this.sql.exec(
        'INSERT INTO events VALUES (?, ?, ?, ?)',
        eventId,
        fingerprint,
        JSON.stringify(bundle),
        Date.now() + EVIDENCE_RETENTION_MS,
      );
      return bundle;
    });
  }
  getContextConversationIds(customerId: string, limit: number): number[] {
    const row = this.sql
      .exec<{ refs: string | null }>(
        "SELECT json_extract(data, '$.evidenceRefs') AS refs FROM contexts WHERE customer_id = ? AND valid = 1 AND evidence_expires_at > ?",
        customerId,
        Date.now(),
      )
      .toArray()[0];
    const refs: unknown = row?.refs ? JSON.parse(row.refs) : [];
    if (!Array.isArray(refs)) return [];
    const ids = refs.flatMap((ref) =>
      ref?.kind === 'message' && typeof ref.id === 'string' && /^[1-9][0-9]*:[1-9][0-9]*$/.test(ref.id)
        ? [Number(ref.id.split(':')[0])]
        : [],
    );
    return [...new Set(ids)].filter((id) => Number.isSafeInteger(id)).slice(0, limit);
  }
  getContext(customerId: string): CustomerContext {
    const row = this.sql
      .exec<{ data: string | null; evidence_expires_at: number }>(
        'SELECT data, evidence_expires_at FROM contexts WHERE customer_id = ? AND valid = 1',
        customerId,
      )
      .toArray()[0];
    if (!row?.data || row.evidence_expires_at <= Date.now()) throw Error('CONTEXT_UNAVAILABLE');
    return customerContextSchema.parse(JSON.parse(row.data));
  }
  /** Internal structured writer, never exposed as a Markdown upload tool. */
  saveContextProjection(raw: ContextProjection, rawBasis: PlanBasis): void {
    const parsed = contextProjectionSchema.safeParse(raw);
    if (!parsed.success) throw Error('CONTEXT_INVALID');
    let projection = parsed.data;
    const basis = planBasisSchema.parse(rawBasis);
    this.storage.transactionSync(() => {
      const manifest = this.checkBasis(basis);
      if (
        basis.customerId !== projection.customerId ||
        projection.demands.some((d) => d.customerId !== projection.customerId)
      )
        throw Error('CONTEXT_CUSTOMER_MISMATCH');
      const current = this.sql
        .exec<{ version: number }>('SELECT version FROM contexts WHERE customer_id = ?', projection.customerId)
        .toArray()[0];
      if ((current?.version ?? 0) !== basis.contextVersion || projection.version !== basis.contextVersion + 1)
        throw new SafeError('CONTEXT_STALE', 'Customer context changed; reload and reconcile.', false, 409);
      for (const ref of contextEvidenceRefs(projection))
        if (!manifest.sources.some((s) => canonical(s) === canonical(ref))) throw Error('STALE_SOURCE');
      for (const receipt of projection.receipts) {
        const row = this.sql
          .exec<{ receipt: string; customer_id: string }>(
            'SELECT c.receipt, w.customer_id FROM commands c JOIN work_customers w ON w.work_id = c.work_id WHERE c.command_key = ?',
            receipt.commandKey,
          )
          .toArray()[0];
        if (
          !row ||
          row.customer_id !== projection.customerId ||
          canonical(JSON.parse(row.receipt)) !== canonical(receipt)
        )
          throw Error('CONTEXT_RECEIPT_UNVERIFIED');
      }
      const factId = 'customer-context:' + projection.customerId;
      const previous = this.sql
        .exec<{ data: string | null; valid: number; version: number }>(
          'SELECT data, valid, version FROM facts WHERE fact_id = ?',
          factId,
        )
        .toArray()[0];
      // Only an unpublished projection owns the pending slot. A rendered version
      // may be superseded by reconciled work from another conversation.
      if (previous?.data && previous.valid && previous.version > (current?.version ?? 0)) {
        const stored = JSON.parse(previous.data) as { projection: ContextProjection; basis: PlanBasis };
        if (
          contextValue(stored.basis) === contextValue(basis) &&
          contextValue({ ...stored.projection, verifiedAt: projection.verifiedAt }) === contextValue(projection)
        )
          return;
        throw new SafeError('CONTEXT_STALE', 'A context projection is awaiting refresh.', false, 409);
      }
      // Retain canonical facts from the last published version even when this
      // conversation does not repeat them. Only the stored structured envelope
      // can carry historical sources; new facts above require this manifest.
      if (previous?.data && previous.valid && previous.version === basis.contextVersion) {
        const prior = contextProjectionSchema.parse((JSON.parse(previous.data) as { projection: unknown }).projection);
        const replacementKeys = new Set(
          projection.facts.filter((f) => f.certainty === 'confirmed').map((f) => `${f.entity}:${f.field}`),
        );
        const corrections = prior.facts.flatMap((old) => {
          const replacement = projection.facts.find(
            (f) =>
              f.certainty === 'confirmed' &&
              f.entity === old.entity &&
              f.field === old.field &&
              canonical(f.value) !== canonical(old.value),
          );
          return old.certainty === 'confirmed' && replacement ? [{ previous: old, replacement }] : [];
        });
        const unique = <T>(values: T[], key: (value: T) => string): T[] => [
          ...new Map(values.map((value) => [key(value), value])).values(),
        ];
        projection = contextProjectionSchema.parse({
          ...projection,
          primaryRef: projection.primaryRef ?? prior.primaryRef,
          facts: unique(
            [...prior.facts.filter((f) => !replacementKeys.has(`${f.entity}:${f.field}`)), ...projection.facts],
            canonical,
          ),
          contacts: unique([...prior.contacts, ...projection.contacts], (c) => canonical(c.ref)),
          demands: unique([...prior.demands, ...projection.demands], (d) => d.demandId),
          pendingReasons: [...new Set([...prior.pendingReasons, ...projection.pendingReasons])],
          corrections: unique(
            [...(prior.corrections ?? []), ...(projection.corrections ?? []), ...corrections],
            canonical,
          ),
        });
      }
      const expires = Date.now() + EVIDENCE_RETENTION_MS;
      this.sql.exec(
        'INSERT INTO facts (fact_id, work_id, version, valid, data, evidence_expires_at) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(fact_id) DO UPDATE SET work_id = excluded.work_id, version = excluded.version, valid = 1, data = excluded.data, evidence_expires_at = excluded.evidence_expires_at',
        factId,
        basis.lease.workId,
        projection.version,
        JSON.stringify({ projection, basis }),
        expires,
      );
      for (const demand of projection.demands) {
        const owner = this.sql
          .exec<{ customer_id: string }>('SELECT customer_id FROM demands WHERE demand_id = ?', demand.demandId)
          .toArray()[0];
        if (owner && owner.customer_id !== projection.customerId) throw Error('CONTEXT_CUSTOMER_MISMATCH');
        this.sql.exec(
          'INSERT INTO demands VALUES (?, ?, ?, ?, ?) ON CONFLICT(demand_id) DO UPDATE SET version = excluded.version, data = excluded.data, evidence_expires_at = excluded.evidence_expires_at',
          demand.demandId,
          projection.customerId,
          projection.version,
          JSON.stringify(demand),
          expires,
        );
      }
    });
  }
  refreshCustomerContext(customerId: string, expectedVersion: number, allowExpired = false): CustomerContext {
    return this.storage.transactionSync(() => {
      const current = this.sql
        .exec<{ version: number }>('SELECT version FROM contexts WHERE customer_id = ?', customerId)
        .toArray()[0];
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || (current?.version ?? 0) !== expectedVersion)
        throw new SafeError('CONTEXT_STALE', 'Customer context changed; reload and reconcile.', false, 409);
      const row = this.sql
        .exec<{ data: string | null; evidence_expires_at: number }>(
          'SELECT data, evidence_expires_at FROM facts WHERE fact_id = ? AND valid = 1',
          'customer-context:' + customerId,
        )
        .toArray()[0];
      if (!row?.data || row.evidence_expires_at <= Date.now()) throw Error('CONTEXT_PROJECTION_UNAVAILABLE');
      const stored = JSON.parse(row.data) as { projection: ContextProjection; basis: PlanBasis };
      const projection = contextProjectionSchema.parse(stored.projection);
      const basis = planBasisSchema.parse(stored.basis);
      if (
        projection.customerId !== customerId ||
        projection.version !== expectedVersion + 1 ||
        basis.contextVersion !== expectedVersion
      )
        throw new SafeError('CONTEXT_STALE', 'Customer context changed; reload and reconcile.', false, 409);
      this.checkBasis(basis, allowExpired);
      // Refresh confirmed results from durable receipts after facts/results committed.
      projection.receipts = this.sql
        .exec<{ receipt: string }>(
          'SELECT c.receipt FROM commands c JOIN work_customers w ON w.work_id = c.work_id WHERE w.customer_id = ?',
          customerId,
        )
        .toArray()
        .map((r) => JSON.parse(r.receipt) as OperationReceipt);
      const context = customerContextSchema.parse({
        customerId,
        version: projection.version,
        verifiedAt: projection.verifiedAt,
        markdown: renderCustomerContext(projection),
        evidenceRefs: contextEvidenceRefs(projection),
      });
      this.sql.exec(
        'INSERT INTO contexts VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(customer_id) DO UPDATE SET work_id = excluded.work_id, version = excluded.version, valid = 1, data = excluded.data, evidence_expires_at = excluded.evidence_expires_at',
        customerId,
        basis.lease.workId,
        context.version,
        JSON.stringify(context),
        row.evidence_expires_at,
      );
      this.sql.exec(
        'UPDATE plans SET valid = 0 WHERE work_id IN (SELECT work_id FROM work_customers WHERE customer_id = ?)',
        customerId,
      );
      return context;
    });
  }
  getCustomerDemand(customerId: string, demandId: string): DemandRecord {
    const row = this.sql
      .exec<{ data: string | null; evidence_expires_at: number }>(
        'SELECT data, evidence_expires_at FROM demands WHERE demand_id = ? AND customer_id = ?',
        demandId,
        customerId,
      )
      .toArray()[0];
    if (!row?.data || row.evidence_expires_at <= Date.now()) throw Error('DEMAND_UNAVAILABLE');
    return demandRecordSchema.parse(JSON.parse(row.data));
  }
  /** Structured retained state supplies IDs and previous automated values only.
   * Mutable CRM fields must be read again before planning. */
  getPreparationBasis(customerId: string) {
    const demands = this.sql
      .exec<{ data: string | null; evidence_expires_at: number }>(
        'SELECT data, evidence_expires_at FROM demands WHERE customer_id = ? LIMIT 101',
        customerId,
      )
      .toArray()
      .filter((r) => r.data && r.evidence_expires_at > Date.now())
      .map((r) => demandRecordSchema.parse(JSON.parse(r.data!)));
    const commands = this.sql
      .exec<{ data: string }>(
        'SELECT e.data FROM execution_commands e JOIN commands c ON e.command_key = c.command_key JOIN work_customers w ON c.work_id = w.work_id WHERE w.customer_id = ? LIMIT 501',
        customerId,
      )
      .toArray()
      .map((r) => JSON.parse(r.data) as ExecutionCommand)
      .filter((c) => c.state === 'confirmed' && c.receipt.checkedAt && c.receipt.crmRef);
    return { demands, commands };
  }
  findLinkedCustomer(refs: CustomerCandidates['verifiedLinks']) {
    const ids = new Set(
      (refs ?? []).flatMap((link) =>
        this.sql
          .exec<{ customer_id: string }>(
            'SELECT customer_id FROM bindings WHERE binding_key = ?',
            `confirmed-crm:${link.ref.kind}:${link.ref.id}`,
          )
          .toArray()
          .map((row) => row.customer_id),
      ),
    );
    return { customerId: ids.size === 1 ? [...ids][0] : undefined, ambiguous: ids.size > 1 };
  }
  async reserveCommand(raw: CommandReservation): Promise<ReservationResult> {
    const input = commandReservationSchema.parse(raw);
    const fingerprint = await digest({ command: input.command, payloadDigest: input.payloadDigest });
    return this.storage.transactionSync(() => {
      this.checkLease(input.lease);
      const row = this.sql
        .exec<CommandRow>('SELECT * FROM commands WHERE command_key = ?', input.command.commandKey)
        .toArray()[0];
      if (row) {
        const customer = this.sql
          .exec<{ customer_id: string }>('SELECT customer_id FROM work_customers WHERE work_id = ?', row.work_id)
          .toArray()[0];
        if (!customer || customer.customer_id !== input.customerId) throw Error('CONTEXT_CUSTOMER_MISMATCH');
        if (row.digest !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT');
        const receipt = JSON.parse(row.receipt) as OperationReceipt;
        if (row.state === 'confirmed') return { state: 'already_confirmed', version: row.version, receipt };
        if (row.state === 'uncertain') return { state: 'uncertain', version: row.version, receipt };
        if (row.state === 'rejected' || row.state === 'review')
          return { state: 'review', version: row.version, reviewReasons: ['command_requires_review'] };
        const work = this.work(row.work_id);
        if (!work || work.expires_at <= Date.now() || row.fence !== work.fence) {
          receipt.state = 'uncertain';
          this.sql.exec(
            'UPDATE commands SET state = ?, receipt = ?, version = version + 1 WHERE command_key = ?',
            'uncertain',
            JSON.stringify(receipt),
            row.command_key,
          );
          return { state: 'uncertain', version: row.version + 1, receipt };
        }
        return { state: 'busy', version: row.version };
      }
      this.checkDispatch(input);
      if (input.expectedVersion !== 1) throw Error('VERSION_CONFLICT');
      const receipt: OperationReceipt = {
        operationId: input.operationId,
        commandKey: input.command.commandKey,
        state: 'reserved',
        updatedFields: [],
      };
      this.sql.exec(
        'INSERT INTO commands VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
        input.command.commandKey,
        input.operationId,
        input.lease.workId,
        fingerprint,
        input.lease.fence,
        'reserved',
        JSON.stringify(receipt),
      );
      return { state: 'reserved', version: 1, fence: input.lease.fence };
    });
  }
  completeCommand(raw: CommandCompletion): void {
    const input = commandCompletionSchema.parse(raw);
    this.storage.transactionSync(() => {
      const row = this.sql
        .exec<CommandRow>('SELECT * FROM commands WHERE command_key = ?', input.commandKey)
        .toArray()[0];
      if (!row || row.fence !== input.fence) throw Error('LEASE_FENCED');
      const work = this.liveWork(row.work_id);
      if (work.fence !== input.fence) throw Error('LEASE_FENCED');
      if (
        row.version !== input.expectedVersion ||
        row.operation_id !== input.operationId ||
        input.receipt.operationId !== input.operationId ||
        input.receipt.commandKey !== input.commandKey
      )
        throw Error('VERSION_CONFLICT');
      if (
        !['reserved', 'running'].includes(row.state) ||
        !['confirmed', 'uncertain', 'rejected', 'review'].includes(input.receipt.state)
      )
        throw Error('INVALID_COMMAND_TRANSITION');
      this.sql.exec(
        'UPDATE commands SET state = ?, receipt = ?, version = version + 1 WHERE command_key = ? AND version = ? AND fence = ?',
        input.receipt.state,
        JSON.stringify(input.receipt),
        input.commandKey,
        input.expectedVersion,
        input.fence,
      );
    });
  }
  nextEvidenceExpiry(now: number): number {
    let deadline = now + 86_400_000;
    for (const table of ['events', 'snapshot_manifest', 'demands', 'facts', 'contexts', 'plans', 'reviews']) {
      const result = this.sql
        .exec<{ deadline: number | null }>(
          `SELECT MIN(evidence_expires_at) AS deadline FROM ${table} WHERE data IS NOT NULL`,
        )
        .one();
      deadline = Math.min(deadline, result.deadline ?? Infinity);
    }
    return deadline;
  }
  pruneEvidence(now: number): number {
    return this.storage.transactionSync(() => {
      let expired = 0;
      for (const table of ['events', 'snapshot_manifest', 'demands', 'facts', 'contexts', 'plans', 'reviews'])
        expired += this.sql.exec(
          `UPDATE ${table} SET data = NULL WHERE evidence_expires_at <= ? AND data IS NOT NULL`,
          now,
        ).rowsWritten;
      for (const table of ['facts', 'contexts', 'plans'])
        this.sql.exec(`UPDATE ${table} SET valid = 0 WHERE evidence_expires_at <= ?`, now);
      return expired;
    });
  }
}
