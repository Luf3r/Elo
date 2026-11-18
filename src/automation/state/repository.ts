import type { DiscoveryCursor, PendingActivity } from '../discovery';
import type { OperationInput, OperationsStore } from '../operations';
import type { ListReviewsInput, WorkflowReview, WorkflowState } from '../service-state';
import type {
  AgentAnalysis,
  AutomationPolicy,
  CatalogSnapshot,
  CommandCompletion,
  CommandReservation,
  ContextProjection,
  CustomerCandidates,
  PlanBasis,
  ReserveWorkInput,
  SnapshotManifest,
  SyncPlan,
  WorkLease,
} from '../types';
import { AuditRepository, EVIDENCE_RETENTION_MS, type AuditAction } from './repositories/audit';
import { CommandsRepository } from './repositories/commands';
import {
  ContextRepository,
  type ContextEvidenceExtractor,
  type ContextRenderOutput,
  type ContextRenderer,
} from './repositories/context';
import { CustomersRepository, type ResolveWorkHooks } from './repositories/customers';
import { DiscoveryRepository } from './repositories/discovery';
import { PlansRepository } from './repositories/plans';
import { ReviewsRepository } from './repositories/reviews';
import { WorkRepository } from './repositories/work';

export {
  EVIDENCE_RETENTION_MS,
  type ContextEvidenceExtractor,
  type ContextRenderOutput,
  type ContextRenderer,
  type ResolveWorkHooks,
};

/** Thin repository facade composing aggregate repositories for the account Durable Object. */
export class AccountRepository {
  private readonly audit: AuditRepository;
  private readonly discovery: DiscoveryRepository;
  private readonly work: WorkRepository;
  private readonly plans: PlansRepository;
  private readonly reviews: ReviewsRepository;
  private readonly commands: CommandsRepository;
  private readonly customers: CustomersRepository;
  private readonly context: ContextRepository;

  constructor(storage: DurableObjectStorage) {
    this.audit = new AuditRepository(storage, {
      getExecutionPolicy: () => this.plans.getExecutionPolicy(),
      listReviews: (input, owner) => this.reviews.listReviews(input, owner),
      getWorkflow: (workId) => this.work.getWorkflow(workId),
      getWork: (workId) => this.work.getWork(workId),
      getOperation: (id) => this.commands.getOperation(id),
      getExecutionCommand: (key) => this.commands.getExecutionCommand(key),
      setOperationStatus: (id, status) => this.commands.setOperationStatus(id, status),
      publishOperationContext: (id, renderContext) => this.context.publishOperationContext(id, renderContext),
    });
    this.discovery = new DiscoveryRepository(storage, () => this.plans.getExecutionPolicy());
    this.work = new WorkRepository(storage, {
      recordAudit: (action, targetId, version, owner, now) =>
        this.audit.recordAudit(action, targetId, version, owner, now),
      getPendingActivity: (id) => this.discovery.getPendingActivity(id),
      getServicePlan: (planId) => this.plans.getServicePlan(planId),
    });
    this.plans = new PlansRepository(storage, {
      getWorkflow: (workId) => this.work.getWorkflow(workId),
      checkBasis: (basis, allowExpired) => this.work.checkBasis(basis, allowExpired),
      activeReview: (basis) => this.reviews.activeReview(basis),
      recordAudit: (action, targetId, version, owner, now) =>
        this.audit.recordAudit(action, targetId, version, owner, now),
    });
    this.reviews = new ReviewsRepository(storage, {
      getWorkflow: (workId) => this.work.getWorkflow(workId),
      checkBasis: (basis, allowExpired) => this.work.checkBasis(basis, allowExpired),
      getExecutionPolicy: () => this.plans.getExecutionPolicy(),
      recordAudit: (action, targetId, version, owner, now) =>
        this.audit.recordAudit(action, targetId, version, owner, now),
    });
    this.commands = new CommandsRepository(storage, {
      getWork: (id) => this.work.getWork(id),
      liveWork: (id) => this.work.liveWork(id),
      checkLease: (lease) => this.work.checkLease(lease),
      checkBasis: (basis, allowExpired) => this.work.checkBasis(basis, allowExpired),
      getWorkflow: (workId) => this.work.getWorkflow(workId),
      getExecutionPolicy: () => this.plans.getExecutionPolicy(),
      putReview: (review) => this.reviews.putReview(review),
    });
    this.customers = new CustomersRepository(storage, {
      checkBasis: (basis, allowExpired) => this.work.checkBasis(basis, allowExpired),
      activeReview: (basis) => this.reviews.activeReview(basis),
    });
    this.context = new ContextRepository(storage, {
      checkBasis: (basis, allowExpired) => this.work.checkBasis(basis, allowExpired),
      getWorkflow: (workId) => this.work.getWorkflow(workId),
      getOperation: (id) => this.commands.getOperation(id),
      getExecutionCommand: (key) => this.commands.getExecutionCommand(key),
    });
  }

  prepareOperation(input: OperationInput) {
    return this.commands.prepareOperation(input);
  }
  getOperation(id: string) {
    return this.commands.getOperation(id);
  }
  getOperationByRequest(id: string) {
    return this.commands.getOperationByRequest(id);
  }
  hasCommandKey(key: string) {
    return this.commands.hasCommandKey(key);
  }
  recordAudit(action: AuditAction, targetId: string, version: number, owner: WorkLease['owner'], now?: number) {
    return this.audit.recordAudit(action, targetId, version, owner, now);
  }
  listAudit(input: { cursor?: string; limit: number }, owner: WorkLease['owner']) {
    return this.audit.listAudit(input, owner);
  }
  recordChatHint(key: string, fingerprint: string, conversationId: number, now: number) {
    return this.discovery.recordChatHint(key, fingerprint, conversationId, now);
  }
  acknowledgeChatHints(conversationId: number) {
    return this.discovery.acknowledgeChatHints(conversationId);
  }
  getPendingCursor(cursor: string) {
    return this.discovery.getPendingCursor(cursor);
  }
  getPendingActivity(id: string) {
    return this.discovery.getPendingActivity(id);
  }
  savePendingPage(entries: PendingActivity[], policyVersion: number, next?: DiscoveryCursor) {
    return this.discovery.savePendingPage(entries, policyVersion, next);
  }
  recordDelivery(operationId: string, now: number, success: boolean) {
    return this.audit.recordDelivery(operationId, now, success);
  }
  nextMaintenance(now: number) {
    return this.audit.nextMaintenance(now);
  }
  prepareMaintenance(now: number, renderContext: ContextRenderer) {
    return this.audit.prepareMaintenance(now, renderContext);
  }
  publishOperationContext(id: string, renderContext: ContextRenderer) {
    return this.context.publishOperationContext(id, renderContext);
  }
  completeDirectOperation(id: string) {
    return this.context.completeDirectOperation(id);
  }
  reserveExecutionCommand(id: string, key: string) {
    return this.commands.reserveExecutionCommand(id, key);
  }
  getExecutionCommand(key: string) {
    return this.commands.getExecutionCommand(key);
  }
  beginDispatch(id: string, key: string) {
    return this.commands.beginDispatch(id, key);
  }
  finishDispatch(...args: Parameters<OperationsStore['finishDispatch']>) {
    return this.commands.finishDispatch(...args);
  }
  settleReconciliation(...args: Parameters<OperationsStore['settleReconciliation']>) {
    return this.commands.settleReconciliation(...args);
  }
  setOperationStatus(...args: Parameters<OperationsStore['setOperationStatus']>) {
    return this.commands.setOperationStatus(...args);
  }
  getExecutionPolicy() {
    return this.plans.getExecutionPolicy();
  }
  getWorkflow(workId: string) {
    return this.work.getWorkflow(workId);
  }
  saveWorkflow(state: WorkflowState, expectedRevision: number) {
    return this.work.saveWorkflow(state, expectedRevision);
  }
  getServicePlan(planId: string) {
    return this.plans.getServicePlan(planId);
  }
  updatePolicy(policy: AutomationPolicy, expectedVersion: number, owner?: WorkLease['owner']) {
    return this.plans.updatePolicy(policy, expectedVersion, owner);
  }
  putReview(review: WorkflowReview) {
    return this.reviews.putReview(review);
  }
  listReviews(input: ListReviewsInput, owner: WorkLease['owner']) {
    return this.reviews.listReviews(input, owner);
  }
  resolveReview(raw: unknown, owner: WorkLease['owner']) {
    return this.reviews.resolveReview(raw, owner);
  }
  reviewAnalysis(raw: AgentAnalysis, basis: PlanBasis) {
    return this.reviews.reviewAnalysis(raw, basis);
  }
  getServiceStatus(owner: WorkLease['owner']) {
    return this.audit.getServiceStatus(owner);
  }
  beginPreparation(lease: WorkLease) {
    return this.work.beginPreparation(lease);
  }
  renewPreparation(lease: WorkLease, holder: string) {
    return this.work.renewPreparation(lease, holder);
  }
  endPreparation(lease: WorkLease, holder: string) {
    return this.work.endPreparation(lease, holder);
  }
  activate(input: { crmAccountId: string; chatAccountId: string }) {
    return this.plans.activate(input);
  }
  reserveWork(raw: ReserveWorkInput) {
    return this.work.reserveWork(raw);
  }
  getSnapshotVersion(workId: string) {
    return this.work.getSnapshotVersion(workId);
  }
  installSnapshot(rawLease: WorkLease, rawManifest: SnapshotManifest, workflow?: WorkflowState) {
    return this.work.installSnapshot(rawLease, rawManifest, workflow);
  }
  savePlan(raw: SyncPlan, rawBasis: PlanBasis) {
    return this.plans.savePlan(raw, rawBasis);
  }
  resolveWork(
    rawAnalysis: AgentAnalysis,
    rawCandidates: CustomerCandidates,
    catalog: CatalogSnapshot,
    rawBasis: PlanBasis,
    hooks: ResolveWorkHooks,
  ) {
    return this.customers.resolveWork(rawAnalysis, rawCandidates, catalog, rawBasis, hooks);
  }
  getContextConversationIds(customerId: string, limit: number) {
    return this.context.getContextConversationIds(customerId, limit);
  }
  getContext(customerId: string) {
    return this.context.getContext(customerId);
  }
  saveContextProjection(raw: ContextProjection, rawBasis: PlanBasis, extractEvidenceRefs: ContextEvidenceExtractor) {
    return this.context.saveContextProjection(raw, rawBasis, extractEvidenceRefs);
  }
  refreshCustomerContext(
    customerId: string,
    expectedVersion: number,
    renderContext: ContextRenderer,
    allowExpired = false,
  ) {
    return this.context.refreshCustomerContext(customerId, expectedVersion, renderContext, allowExpired);
  }
  getCustomerDemand(customerId: string, demandId: string) {
    return this.customers.getCustomerDemand(customerId, demandId);
  }
  getPreparationBasis(customerId: string) {
    return this.customers.getPreparationBasis(customerId);
  }
  findLinkedCustomer(refs: CustomerCandidates['verifiedLinks']) {
    return this.customers.findLinkedCustomer(refs);
  }
  reserveCommand(raw: CommandReservation) {
    return this.commands.reserveCommand(raw);
  }
  completeCommand(raw: CommandCompletion) {
    return this.commands.completeCommand(raw);
  }
  nextEvidenceExpiry(now: number) {
    return this.audit.nextEvidenceExpiry(now);
  }
  pruneEvidence(now: number) {
    return this.audit.pruneEvidence(now);
  }
}
