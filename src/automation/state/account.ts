import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../../env';
import type { ReserveWorkInput, PlanBasis, WorkLease, SnapshotManifest, SyncPlan, CommandReservation, CommandCompletion, ContextProjection } from '../types';
import { migrate } from './migrations';
import { AccountRepository } from './repository';
import type { OperationsStore, OperationInput } from '../operations';
import { takeBudget } from './budget';
import type { AgentAnalysis, CustomerCandidates, CatalogSnapshot } from '../types';
import type { WorkflowState, WorkflowReview, ListReviewsInput } from '../service-state';
import type { AutomationPolicy } from '../types';
export class AutomationAccount extends DurableObject<Env> {
  private readonly repository: AccountRepository;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.repository = new AccountRepository(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage);
      this.repository.pruneEvidence(Date.now());
      if (await ctx.storage.getAlarm() === null) await ctx.storage.setAlarm(this.repository.nextEvidenceExpiry(Date.now()));
    });
  }
  async reserveWork(input: ReserveWorkInput) { return this.repository.reserveWork(input); }
  async prepareOperation(input: OperationInput) { return this.repository.prepareOperation(input); }
  async getOperation(id: string) { return this.repository.getOperation(id); }
  async completeDirectOperation(id: string) { return this.repository.completeDirectOperation(id); }
  async getExecutionPolicy() { return this.repository.getExecutionPolicy(); }
  async getWorkflow(id: string): Promise<string | undefined> { const state = this.repository.getWorkflow(id); return state ? JSON.stringify(state) : undefined; }
  async saveWorkflow(state: WorkflowState, revision: number) { return this.repository.saveWorkflow(state, revision); }
  async getServicePlan(id: string): Promise<string | undefined> { const plan = this.repository.getServicePlan(id); return plan ? JSON.stringify(plan) : undefined; }
  async findContext(customerId: string) { try { return this.repository.getContext(customerId); } catch { return undefined; } }
  async updatePolicy(policy: AutomationPolicy, version: number) { return this.repository.updatePolicy(policy, version); }
  async putReview(review: WorkflowReview) { return this.repository.putReview(review); }
  async listReviews(input: ListReviewsInput, owner: WorkLease['owner']) { return this.repository.listReviews(input, owner); }
  async resolveReview(input: unknown, owner: WorkLease['owner']) { return this.repository.resolveReview(input, owner); }
  async getServiceStatus(owner: WorkLease['owner']) { return this.repository.getServiceStatus(owner); }
  async getOperationByRequest(id: string) { return this.repository.getOperationByRequest(id); }
  async reserveExecutionCommand(id: string, key: string) { return this.repository.reserveExecutionCommand(id, key); }
  async getExecutionCommand(key: string) { return this.repository.getExecutionCommand(key); }
  async beginDispatch(id: string, key: string) { return this.repository.beginDispatch(id, key); }
  async finishDispatch(...args: Parameters<OperationsStore['finishDispatch']>) { return this.repository.finishDispatch(...args); }
  async settleReconciliation(...args: Parameters<OperationsStore['settleReconciliation']>) { return this.repository.settleReconciliation(...args); }
  async setOperationStatus(...args: Parameters<OperationsStore['setOperationStatus']>) { return this.repository.setOperationStatus(...args); }
  async installSnapshot(lease: WorkLease, manifest: SnapshotManifest) { return this.repository.installSnapshot(lease, manifest); }
  async savePlan(plan: SyncPlan, basis: PlanBasis) { return this.repository.savePlan(plan, basis); }
  async getContext(customerId: string) { return this.repository.getContext(customerId); }
  async saveContextProjection(projection: ContextProjection, basis: PlanBasis) { return this.repository.saveContextProjection(projection, basis); }
  async refreshCustomerContext(customerId: string, expectedVersion: number) { return this.repository.refreshCustomerContext(customerId, expectedVersion); }
  async getCustomerDemand(customerId: string, demandId: string) { return this.repository.getCustomerDemand(customerId, demandId); }
  async resolveWork(analysis: AgentAnalysis, candidates: CustomerCandidates, catalog: CatalogSnapshot, basis: PlanBasis) { return this.repository.resolveWork(analysis, candidates, catalog, basis); }
  async reserveCommand(input: CommandReservation) { return this.repository.reserveCommand(input); }
  async completeCommand(input: CommandCompletion) { return this.repository.completeCommand(input); }
  async takeBudget(product: 'crm' | 'chat', now: number) { return takeBudget(this.ctx.storage, product, now); }
  /** Receives server-verified identities only. A mismatch requires explicit operator reconfiguration. */
  async activate(input: { crmAccountId: string; chatAccountId: string }) { return this.repository.activate(input); }
  async alarm() { this.repository.pruneEvidence(Date.now()); await this.ctx.storage.setAlarm(this.repository.nextEvidenceExpiry(Date.now())); }
}
