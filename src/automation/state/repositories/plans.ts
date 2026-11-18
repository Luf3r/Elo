import { automationPolicySchema } from '../../../domain/policy-types';
import { canonical } from '../../../shared/canonical';
import { readJson } from '../../../shared/json';
import { payloadDigest } from '../../operations';
import { planBasisSchema, syncPlanSchema } from '../../schemas';
import type { WorkflowReview, WorkflowState } from '../../service-state';
import type { AutomationPolicy, PlanBasis, SnapshotManifest, SyncPlan, WorkLease } from '../../types';
import { EVIDENCE_RETENTION_MS, type AuditAction } from './audit';

export interface PlansDeps {
  getWorkflow: (workId: string) => WorkflowState | undefined;
  checkBasis: (basis: PlanBasis, allowExpired?: boolean) => SnapshotManifest;
  activeReview: (
    basis: PlanBasis,
  ) => { pending: NonNullable<WorkflowState['pendingReview']>; review: WorkflowReview } | undefined;
  recordAudit: (
    action: AuditAction,
    targetId: string,
    version: number,
    owner: WorkLease['owner'],
    now?: number,
  ) => void;
}

/** Manages account binding, execution policy and persisted sync plans. */
export class PlansRepository {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly deps: PlansDeps,
  ) {}

  private get sql() {
    return this.storage.sql;
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

  getExecutionPolicy() {
    const row = this.sql.exec<{ data: string }>('SELECT data FROM policy WHERE singleton = 1').toArray()[0];
    return row ? readJson(automationPolicySchema, row.data, 'policy.data') : undefined;
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
      if (owner) this.deps.recordAudit('policy_updated', 'policy', valid.version, owner);
      return valid;
    });
  }

  getServicePlan(planId: string): { plan: SyncPlan; workflow: WorkflowState } | undefined {
    const row = this.sql
      .exec<{ work_id: string; data: string | null; evidence_expires_at: number; valid: number }>(
        'SELECT work_id, data, evidence_expires_at, valid FROM plans WHERE plan_id = ?',
        planId,
      )
      .toArray()[0];
    if (!row?.valid || !row.data || row.evidence_expires_at <= Date.now()) return;
    const workflow = this.deps.getWorkflow(row.work_id);
    if (!workflow) return;
    return { plan: readJson(syncPlanSchema, row.data, 'plans.data'), workflow };
  }

  async savePlan(raw: SyncPlan, rawBasis: PlanBasis): Promise<void> {
    const plan = syncPlanSchema.parse(raw);
    const basis = planBasisSchema.parse(rawBasis);
    const fingerprint = await payloadDigest(plan);
    this.storage.transactionSync(() => {
      if (plan.workId !== basis.lease.workId) throw Error('LEASE_FENCED');
      const manifest = this.deps.checkBasis(basis);
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
      const active = this.deps.activeReview(basis);
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
        this.deps.recordAudit('review_consumed', active.review.reviewId, active.review.version, basis.lease.owner);
      }
    });
  }
}
