import { applyReviewDecision } from '../../../domain/reviews';
import { canonical } from '../../../shared/canonical';
import { readJson } from '../../../shared/json';
import { reviewResolutionInputSchema, snapshotManifestSchema } from '../../schemas';
import {
  workflowReviewSchema,
  type ListReviewsInput,
  type WorkflowReview,
  type WorkflowState,
} from '../../service-state';
import type { AgentAnalysis, AutomationPolicy, PlanBasis, SnapshotManifest, WorkLease } from '../../types';
import { EVIDENCE_RETENTION_MS, type AuditAction } from './audit';

export interface ReviewsDeps {
  getWorkflow: (workId: string) => WorkflowState | undefined;
  checkBasis: (basis: PlanBasis, allowExpired?: boolean) => SnapshotManifest;
  getExecutionPolicy: () => AutomationPolicy | undefined;
  recordAudit: (
    action: AuditAction,
    targetId: string,
    version: number,
    owner: WorkLease['owner'],
    now?: number,
  ) => void;
}

/** Manages workflow review creation, listing, resolution and replay verification. */
export class ReviewsRepository {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly deps: ReviewsDeps,
  ) {}

  private get sql() {
    return this.storage.sql;
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
      .map((r) => readJson(workflowReviewSchema, r.data, 'reviews.data'))
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
      const review = readJson(workflowReviewSchema, row.data, 'reviews.data');
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
        const snapshot = readJson(snapshotManifestSchema, manifest.data, 'snapshot_manifest.data');
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
        const workflow = this.deps.getWorkflow(review.workId);
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
          sourceRefs: readJson(snapshotManifestSchema, manifest.data, 'snapshot_manifest.data').sources,
          analysis: workflow.analysis,
          policyVersion: this.deps.getExecutionPolicy()?.version ?? 1,
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
      this.deps.recordAudit('review_resolved', review.reviewId, resolved.version, owner);
      return resolved;
    });
  }

  activeReview(basis: PlanBasis) {
    const workflow = this.deps.getWorkflow(basis.lease.workId);
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
    const review = readJson(workflowReviewSchema, row.data, 'reviews.data');
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
    const manifest = this.deps.checkBasis(basis);
    if (pending.sourceRefs.some((ref) => !manifest.sources.some((source) => canonical(source) === canonical(ref))))
      throw Error('REVIEW_SOURCE_CHANGED');
    if (
      pending.decision.kind === 'approvePlan' &&
      (this.deps.getExecutionPolicy()?.version ?? 1) !== pending.policyVersion
    )
      throw Error('REVIEW_POLICY_CHANGED');
    return { pending, review };
  }

  reviewAnalysis(raw: AgentAnalysis, basis: PlanBasis): AgentAnalysis {
    const active = this.activeReview(basis);
    return active ? applyReviewDecision(raw, active.pending) : raw;
  }
}
