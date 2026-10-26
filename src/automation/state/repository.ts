import type { CommandCompletion, CommandReservation, CustomerContext, OperationReceipt, ReservationResult, ReserveWorkInput, SnapshotManifest, SyncPlan, WorkLease } from '../types';
import { commandCompletionSchema, commandReservationSchema, customerContextSchema, reserveWorkInputSchema, snapshotManifestSchema, syncPlanSchema, workLeaseSchema } from '../schemas';

export const EVIDENCE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(bytes), v => v.toString(16).padStart(2, '0')).join('');
}
type WorkRow = { work_id: string; digest: string; target_key: string; lease: string; expires_at: number; fence: number };
type CommandRow = { command_key: string; operation_id: string; work_id: string; digest: string; fence: number; version: number; state: OperationReceipt['state']; receipt: string };
/** Every mutation transaction below is synchronous. Hashing occurs before it; network never occurs inside it. */
export class AccountRepository {
  constructor(private readonly storage: DurableObjectStorage) {}
  private get sql() { return this.storage.sql; }
  private work(id: string): WorkRow | undefined { return this.sql.exec<WorkRow>('SELECT * FROM work WHERE work_id = ?', id).toArray()[0]; }
  private liveWork(id: string): WorkRow {
    const row = this.work(id);
    if (!row || row.expires_at <= Date.now()) throw Error('LEASE_EXPIRED');
    const owner = this.sql.exec<{ fence: number }>('SELECT fence FROM identity_reservations WHERE target_key = ?', row.target_key).toArray()[0];
    if (owner?.fence !== row.fence) throw Error('LEASE_FENCED');
    return row;
  }
  private checkLease(lease: WorkLease): WorkRow {
    const row = this.liveWork(lease.workId);
    if (canonical(JSON.parse(row.lease)) !== canonical(lease)) throw Error('LEASE_FENCED');
    return row;
  }
  private invalidate(workId: string) {
    this.sql.exec('UPDATE plans SET valid = 0 WHERE work_id = ?', workId);
    this.sql.exec('UPDATE facts SET valid = 0 WHERE work_id = ?', workId);
    this.sql.exec('UPDATE contexts SET valid = 0 WHERE work_id = ?', workId);
  }
  activate(input: { crmAccountId: string; chatAccountId: string }): void {
    if (!input.crmAccountId || !input.chatAccountId || input.crmAccountId.length > 200 || input.chatAccountId.length > 200) throw Error('INVALID_ACCOUNT_BINDING');
    this.storage.transactionSync(() => {
      const row = this.sql.exec<{ crm_account_id: string; chat_account_id: string }>('SELECT * FROM account_binding WHERE singleton = 1').toArray()[0];
      if (row && (row.crm_account_id !== input.crmAccountId || row.chat_account_id !== input.chatAccountId)) throw Error('ACCOUNT_RECONFIGURATION_REQUIRED');
      if (!row) this.sql.exec('INSERT INTO account_binding VALUES (1, ?, ?)', input.crmAccountId, input.chatAccountId);
    });
  }
  async reserveWork(raw: ReserveWorkInput): Promise<WorkLease> {
    const input = reserveWorkInputSchema.parse(raw);
    const fingerprint = await digest({ target: input.target, mode: input.mode, actor: { userId: input.actor.userId, clientId: input.actor.clientId, scopes: [...input.actor.scopes].sort() }, payloadDigest: input.payloadDigest });
    const targetKey = await digest(input.target);
    return this.storage.transactionSync(() => {
      const now = Date.now();
      if (input.actor.expiresAt !== undefined && input.actor.expiresAt <= now) throw Error('AUTHORIZATION_EXPIRED');
      const previous = this.sql.exec<WorkRow>('SELECT * FROM work WHERE request_id = ?', input.requestId).toArray()[0];
      if (previous && previous.digest !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT');
      if (previous && previous.expires_at > now) return JSON.parse(previous.lease) as WorkLease;
      const identity = this.sql.exec<{ work_id: string; fence: number }>('SELECT * FROM identity_reservations WHERE target_key = ?', targetKey).toArray()[0];
      if (identity && (this.work(identity.work_id)?.expires_at ?? 0) > now) throw Error('WORK_BUSY');
      const lease: WorkLease = { workId: previous?.work_id ?? crypto.randomUUID(), leaseToken: crypto.randomUUID(), owner: { userId: input.actor.userId, clientId: input.actor.clientId }, fence: (identity?.fence ?? 0) + 1, expiresAt: new Date(now + 600_000).toISOString(), mode: input.mode, target: input.target };
      if (identity) {
        this.invalidate(identity.work_id);
        this.sql.exec('UPDATE snapshot_manifest SET data = NULL WHERE work_id = ?', identity.work_id);
      }
      this.sql.exec('INSERT INTO work VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(work_id) DO UPDATE SET lease = excluded.lease, expires_at = excluded.expires_at, fence = excluded.fence', lease.workId, input.requestId, fingerprint, targetKey, JSON.stringify(lease), now + 600_000, lease.fence);
      this.sql.exec('INSERT INTO identity_reservations VALUES (?, ?, ?) ON CONFLICT(target_key) DO UPDATE SET work_id = excluded.work_id, fence = excluded.fence', targetKey, lease.workId, lease.fence);
      return lease;
    });
  }
  async installSnapshot(rawLease: WorkLease, rawManifest: SnapshotManifest): Promise<void> {
    const lease = workLeaseSchema.parse(rawLease); const manifest = snapshotManifestSchema.parse(rawManifest);
    if (manifest.workId !== lease.workId) throw Error('LEASE_FENCED');
    const fingerprint = await digest(manifest);
    this.storage.transactionSync(() => {
      this.checkLease(lease);
      const previous = this.sql.exec<{ version: number; digest: string }>('SELECT version, digest FROM snapshot_manifest WHERE work_id = ?', lease.workId).toArray()[0];
      if (previous?.version === manifest.snapshotVersion && previous.digest === fingerprint) return;
      if (manifest.snapshotVersion !== (previous?.version ?? 0) + 1) throw Error('VERSION_CONFLICT');
      this.invalidate(lease.workId);
      this.sql.exec('INSERT INTO snapshot_manifest VALUES (?, ?, ?, ?, ?) ON CONFLICT(work_id) DO UPDATE SET version = excluded.version, digest = excluded.digest, data = excluded.data, evidence_expires_at = excluded.evidence_expires_at', lease.workId, manifest.snapshotVersion, fingerprint, JSON.stringify(manifest), Date.now() + EVIDENCE_RETENTION_MS);
    });
  }
  async savePlan(raw: SyncPlan): Promise<void> {
    const plan = syncPlanSchema.parse(raw); const fingerprint = await digest(plan);
    this.storage.transactionSync(() => {
      this.liveWork(plan.workId);
      const manifest = this.sql.exec<{ data: string | null; evidence_expires_at: number }>('SELECT data, evidence_expires_at FROM snapshot_manifest WHERE work_id = ?', plan.workId).toArray()[0];
      if (!manifest?.data || manifest.evidence_expires_at <= Date.now()) throw Error('SNAPSHOT_REQUIRED');
      const sources = (JSON.parse(manifest.data) as SnapshotManifest).sources;
      for (const ref of [...plan.sourceRefs, ...plan.before.flatMap(f => f.sources), ...plan.after.flatMap(f => f.sources), ...plan.orderedCommands.flatMap(c => [...c.sourceRefs, ...c.before.flatMap(f => f.sources)])]) if (!sources.some(s => canonical(s) === canonical(ref))) throw Error('STALE_SOURCE');
      const previous = this.sql.exec<{ work_id: string; version: number; digest: string; valid: number }>('SELECT work_id, version, digest, valid FROM plans WHERE plan_id = ?', plan.planId).toArray()[0];
      if (previous && previous.work_id !== plan.workId) throw Error('IDEMPOTENCY_CONFLICT');
      if (previous?.version === plan.version && previous.digest === fingerprint && previous.valid) return;
      if (plan.version !== (previous?.version ?? 0) + 1) throw Error('VERSION_CONFLICT');
      this.sql.exec('INSERT INTO plans VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT(plan_id) DO UPDATE SET version = excluded.version, digest = excluded.digest, valid = 1, data = excluded.data, evidence_expires_at = excluded.evidence_expires_at', plan.planId, plan.workId, plan.version, fingerprint, JSON.stringify(plan), Date.now() + EVIDENCE_RETENTION_MS);
    });
  }
  getContext(customerId: string): CustomerContext {
    const row = this.sql.exec<{ data: string | null; evidence_expires_at: number }>('SELECT data, evidence_expires_at FROM contexts WHERE customer_id = ? AND valid = 1', customerId).toArray()[0];
    if (!row?.data || row.evidence_expires_at <= Date.now()) throw Error('CONTEXT_UNAVAILABLE');
    return customerContextSchema.parse(JSON.parse(row.data));
  }
  async reserveCommand(raw: CommandReservation): Promise<ReservationResult> {
    const input = commandReservationSchema.parse(raw); const fingerprint = await digest({ command: input.command, payloadDigest: input.payloadDigest });
    return this.storage.transactionSync(() => {
      this.checkLease(input.lease);
      const row = this.sql.exec<CommandRow>('SELECT * FROM commands WHERE command_key = ?', input.command.commandKey).toArray()[0];
      if (row) {
        if (row.digest !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT');
        const receipt = JSON.parse(row.receipt) as OperationReceipt;
        if (row.state === 'confirmed') return { state: 'already_confirmed', version: row.version, receipt };
        if (row.state === 'uncertain') return { state: 'uncertain', version: row.version, receipt };
        if (row.state === 'rejected' || row.state === 'review') return { state: 'review', version: row.version, reviewReasons: ['command_requires_review'] };
        const work = this.work(row.work_id);
        if (!work || work.expires_at <= Date.now() || row.fence !== work.fence) {
          receipt.state = 'uncertain';
          this.sql.exec('UPDATE commands SET state = ?, receipt = ?, version = version + 1 WHERE command_key = ?', 'uncertain', JSON.stringify(receipt), row.command_key);
          return { state: 'uncertain', version: row.version + 1, receipt };
        }
        return { state: 'busy', version: row.version };
      }
      if (input.expectedVersion !== 1) throw Error('VERSION_CONFLICT');
      const receipt: OperationReceipt = { operationId: input.operationId, commandKey: input.command.commandKey, state: 'reserved', updatedFields: [] };
      this.sql.exec('INSERT INTO commands VALUES (?, ?, ?, ?, ?, 1, ?, ?)', input.command.commandKey, input.operationId, input.lease.workId, fingerprint, input.lease.fence, 'reserved', JSON.stringify(receipt));
      return { state: 'reserved', version: 1, fence: input.lease.fence };
    });
  }
  completeCommand(raw: CommandCompletion): void {
    const input = commandCompletionSchema.parse(raw);
    this.storage.transactionSync(() => {
      const row = this.sql.exec<CommandRow>('SELECT * FROM commands WHERE command_key = ?', input.commandKey).toArray()[0];
      if (!row || row.fence !== input.fence) throw Error('LEASE_FENCED');
      const work = this.liveWork(row.work_id);
      if (work.fence !== input.fence) throw Error('LEASE_FENCED');
      if (row.version !== input.expectedVersion || row.operation_id !== input.operationId || input.receipt.operationId !== input.operationId || input.receipt.commandKey !== input.commandKey) throw Error('VERSION_CONFLICT');
      if (!['reserved', 'running'].includes(row.state) || !['confirmed', 'uncertain', 'rejected', 'review'].includes(input.receipt.state)) throw Error('INVALID_COMMAND_TRANSITION');
      this.sql.exec('UPDATE commands SET state = ?, receipt = ?, version = version + 1 WHERE command_key = ? AND version = ? AND fence = ?', input.receipt.state, JSON.stringify(input.receipt), input.commandKey, input.expectedVersion, input.fence);
    });
  }
  nextEvidenceExpiry(now: number): number {
    let deadline = now + 86_400_000;
    for (const table of ['events', 'snapshot_manifest', 'demands', 'facts', 'contexts', 'plans', 'reviews']) {
      const result = this.sql.exec<{ deadline: number | null }>(`SELECT MIN(evidence_expires_at) AS deadline FROM ${table} WHERE data IS NOT NULL`).one();
      deadline = Math.min(deadline, result.deadline ?? Infinity);
    }
    return deadline;
  }
  pruneEvidence(now: number): void {
    this.storage.transactionSync(() => {
      for (const table of ['events', 'snapshot_manifest', 'demands', 'facts', 'contexts', 'plans', 'reviews']) this.sql.exec(`UPDATE ${table} SET data = NULL WHERE evidence_expires_at <= ? AND data IS NOT NULL`, now);
      for (const table of ['facts', 'contexts', 'plans']) this.sql.exec(`UPDATE ${table} SET valid = 0 WHERE evidence_expires_at <= ?`, now);
    });
  }
}
