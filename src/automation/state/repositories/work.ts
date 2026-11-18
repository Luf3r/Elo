import { canonical } from '../../../shared/canonical';
import { SafeError } from '../../../shared/errors';
import { readJson } from '../../../shared/json';
import type { PendingActivity } from '../../discovery';
import { payloadDigest } from '../../operations';
import { reserveWorkInputSchema, snapshotManifestSchema, workLeaseSchema } from '../../schemas';
import { workflowStateSchema, type WorkflowState } from '../../service-state';
import type { PlanBasis, ReserveWorkInput, SnapshotManifest, SyncPlan, WorkLease } from '../../types';
import { EVIDENCE_RETENTION_MS, type AuditAction } from './audit';

export type WorkRow = {
  work_id: string;
  digest: string;
  target_key: string;
  lease: string;
  expires_at: number;
  fence: number;
};

export interface WorkDeps {
  recordAudit: (
    action: AuditAction,
    targetId: string,
    version: number,
    owner: WorkLease['owner'],
    now?: number,
  ) => void;
  getPendingActivity: (id: string) => (PendingActivity & { planId: string | null }) | undefined;
  getServicePlan: (planId: string) => { plan: SyncPlan; workflow: WorkflowState } | undefined;
}

/** Manages work leases, fencing tokens, preparation locks, workflows and snapshot manifests. */
export class WorkRepository {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly deps: WorkDeps,
  ) {}

  private get sql() {
    return this.storage.sql;
  }

  getWork(id: string): WorkRow | undefined {
    return this.sql.exec<WorkRow>('SELECT * FROM work WHERE work_id = ?', id).toArray()[0];
  }

  liveWork(id: string): WorkRow {
    const row = this.getWork(id);
    if (!row || row.expires_at <= Date.now()) throw Error('LEASE_EXPIRED');
    const owner = this.sql
      .exec<{ fence: number }>('SELECT fence FROM identity_reservations WHERE target_key = ?', row.target_key)
      .toArray()[0];
    if (owner?.fence !== row.fence) throw Error('LEASE_FENCED');
    return row;
  }

  checkLease(lease: WorkLease): WorkRow {
    const row = this.liveWork(lease.workId);
    if (canonical(readJson(workLeaseSchema, row.lease, 'work.lease')) !== canonical(lease)) throw Error('LEASE_FENCED');
    return row;
  }

  checkBasis(basis: PlanBasis, allowExpired = false): SnapshotManifest {
    if (allowExpired) {
      const work = this.getWork(basis.lease.workId);
      if (!work || canonical(readJson(workLeaseSchema, work.lease, 'work.lease')) !== canonical(basis.lease))
        throw Error('LEASE_FENCED');
    } else this.checkLease(basis.lease);
    const row = this.sql
      .exec<{ data: string | null; evidence_expires_at: number }>(
        'SELECT data, evidence_expires_at FROM snapshot_manifest WHERE work_id = ?',
        basis.lease.workId,
      )
      .toArray()[0];
    if (!row?.data || row.evidence_expires_at <= Date.now()) throw Error('SNAPSHOT_REQUIRED');
    const manifest = readJson(snapshotManifestSchema, row.data, 'snapshot_manifest.data');
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

  invalidate(workId: string) {
    this.sql.exec('UPDATE plans SET valid = 0 WHERE work_id = ?', workId);
    this.sql.exec('UPDATE facts SET valid = 0 WHERE work_id = ?', workId);
    this.sql.exec('UPDATE contexts SET valid = 0 WHERE work_id = ?', workId);
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
      this.deps.recordAudit('preparation_lock_acquired', lease.workId, lease.fence, lease.owner);
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
      this.deps.recordAudit('preparation_lock_released', lease.workId, lease.fence, lease.owner);
    });
  }

  async reserveWork(raw: ReserveWorkInput): Promise<WorkLease> {
    const input = reserveWorkInputSchema.parse(raw);
    const fingerprint = await payloadDigest({
      target: input.target,
      mode: input.mode,
      actor: { userId: input.actor.userId, clientId: input.actor.clientId, scopes: [...input.actor.scopes].sort() },
      payloadDigest: input.payloadDigest,
    });
    const targetKey = await payloadDigest(input.target);
    return this.storage.transactionSync(() => {
      const now = Date.now();
      if (input.actor.expiresAt !== undefined && input.actor.expiresAt <= now) throw Error('AUTHORIZATION_EXPIRED');
      const previous = this.sql.exec<WorkRow>('SELECT * FROM work WHERE request_id = ?', input.requestId).toArray()[0];
      if (previous && previous.digest !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT');
      if (previous && previous.expires_at > now) return readJson(workLeaseSchema, previous.lease, 'work.lease');
      const identity = this.sql
        .exec<{ work_id: string; fence: number }>('SELECT * FROM identity_reservations WHERE target_key = ?', targetKey)
        .toArray()[0];
      if (identity && (this.getWork(identity.work_id)?.expires_at ?? 0) > now) throw Error('WORK_BUSY');
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
      this.deps.recordAudit('lease_acquired', lease.workId, lease.fence, lease.owner);
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
    const fingerprint = await payloadDigest(manifest);
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
      this.deps.recordAudit('snapshot_persisted', lease.workId, manifest.snapshotVersion, lease.owner);
    });
  }

  getWorkflow(workId: string): WorkflowState | undefined {
    const row = this.sql
      .exec<{ data: string | null; evidence_expires_at: number }>(
        'SELECT data, evidence_expires_at FROM events WHERE event_id = ?',
        'workflow:' + workId,
      )
      .toArray()[0];
    if (!row?.data || row.evidence_expires_at <= Date.now()) return;
    return readJson(workflowStateSchema, row.data, 'events.data');
  }

  saveWorkflow(state: WorkflowState, expectedRevision: number): void {
    this.storage.transactionSync(() => {
      this.writeWorkflow(state, expectedRevision);
      if (state.discoveryId && state.discoveryPlanId) {
        const event = this.deps.getPendingActivity(state.discoveryId);
        const plan = this.deps.getServicePlan(state.discoveryPlanId);
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

  writeWorkflow(state: WorkflowState, expectedRevision: number): void {
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
    if (!prior) this.deps.recordAudit('work_created', state.lease.workId, state.lease.fence, state.lease.owner);
    else if (state.step !== prior.step)
      this.deps.recordAudit('preparation_progress', state.lease.workId, state.step, state.lease.owner);
    if (
      state.preparationDeferral &&
      JSON.stringify(state.preparationDeferral) !== JSON.stringify(prior?.preparationDeferral)
    ) {
      const d = state.preparationDeferral;
      this.deps.recordAudit(`preparation_deferred_${d.reason}`, state.lease.workId, d.attempts, state.lease.owner);
      if (d.blocked) this.deps.recordAudit('preparation_blocked', state.lease.workId, d.attempts, state.lease.owner);
    }
  }
}
