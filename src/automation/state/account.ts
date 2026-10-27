import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../../env';
import type { ReserveWorkInput, PlanBasis, WorkLease, SnapshotManifest, SyncPlan, CommandReservation, CommandCompletion, ContextProjection } from '../types';
import { migrate } from './migrations';
import { AccountRepository } from './repository';
import { takeBudget } from './budget';
import type { AgentAnalysis, CustomerCandidates, CatalogSnapshot } from '../types';
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
