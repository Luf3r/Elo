import { readJson } from '../../../shared/json';
import { WATCHDOG_INTERVAL_MS } from '../../execution/maintenance';
import { executionOperationSchema, type ExecutionCommand, type ExecutionOperation } from '../../operations';
import {
  workflowStateSchema,
  type ListReviewsInput,
  type WorkflowReview,
  type WorkflowState,
} from '../../service-state';
import type { AutomationPolicy, OperationStatus, WorkLease } from '../../types';
import type { ContextRenderer } from './context';
import type { WorkRow } from './work';

export const EVIDENCE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export type AuditAction =
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
  | `preparation_failed_${string}`;

export interface AuditDeps {
  getExecutionPolicy: () => AutomationPolicy | undefined;
  listReviews: (input: ListReviewsInput, owner: WorkLease['owner']) => { reviews: WorkflowReview[] };
  getWorkflow: (workId: string) => WorkflowState | undefined;
  getWork: (workId: string) => WorkRow | undefined;
  getOperation: (id: string) => ExecutionOperation | undefined;
  getExecutionCommand: (key: string) => ExecutionCommand | undefined;
  setOperationStatus: (id: string, status: OperationStatus) => OperationStatus;
  publishOperationContext: (id: string, renderContext: ContextRenderer) => void;
}

const EVIDENCE_TABLES = ['events', 'snapshot_manifest', 'demands', 'facts', 'contexts', 'plans', 'reviews'] as const;

/** Persists operational audit records, evidence expiry pruning, service status and maintenance. */
export class AuditRepository {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly deps: AuditDeps,
  ) {}

  private get sql() {
    return this.storage.sql;
  }

  recordAudit(
    action: AuditAction,
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

  getServiceStatus(owner: WorkLease['owner']) {
    const policy = this.deps.getExecutionPolicy();
    const pendingReviews = this.deps.listReviews({ limit: 100 }, owner).reviews.length;
    const pendingOperations = this.sql
      .exec<{ data: string }>('SELECT data FROM execution_operations')
      .toArray()
      .map((r) => readJson(executionOperationSchema, r.data, 'execution_operations.data'))
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
      .map((r) => readJson(workflowStateSchema, r.data, 'events.data'))
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

  prepareMaintenance(now: number, renderContext: ContextRenderer) {
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
      const policy = this.deps.getExecutionPolicy();
      const operations = this.sql
        .exec<{ request_id: string; digest: string; data: string }>(
          'SELECT request_id, digest, data FROM execution_operations',
        )
        .toArray();
      for (const row of operations) {
        const operation = readJson(executionOperationSchema, row.data, 'execution_operations.data');
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
            this.deps.publishOperationContext(operation.operationId, renderContext);
          } catch {
            /* Retain pending projection for explicit reconciliation. */
          }
          continue;
        }
        if (!['queued', 'running', 'uncertain'].includes(operation.status.state)) continue;
        const commands = operation.input.authorization.plan.orderedCommands.map((c) =>
          this.deps.getExecutionCommand(c.commandKey),
        );
        const inFlight = commands.some((c) => c?.state === 'sending' || c?.state === 'uncertain');
        if (!inFlight) {
          if (
            Date.parse(operation.input.authorization.validUntil) <= now ||
            (operation.input.authorization.actor.expiresAt ?? 0) <= now ||
            (this.deps.getWork(operation.input.basis.lease.workId)?.expires_at ?? 0) <= now
          ) {
            this.deps.setOperationStatus(operation.operationId, {
              operationId: operation.operationId,
              state: 'authorization_expired',
              receipts: [],
              pendingReasons: ['AUTHORIZATION_EXPIRED'],
            });
            continue;
          }
          if (
            !this.deps.getWorkflow(operation.input.basis.lease.workId)?.direct &&
            policy &&
            (policy.mode !== 'apply' || policy.version !== operation.input.authorization.plan.policyVersion)
          ) {
            this.deps.setOperationStatus(operation.operationId, {
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
          const operation = this.deps.getOperation(row.operation_id);
          return operation ? [operation] : [];
        });
      return { expiredEvidence, expiredReservations: expired.length, due };
    });
  }

  nextEvidenceExpiry(now: number): number {
    let deadline = now + 86_400_000;
    for (const table of EVIDENCE_TABLES) {
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
      for (const table of EVIDENCE_TABLES)
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
