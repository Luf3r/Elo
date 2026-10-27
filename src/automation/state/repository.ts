import type { CommandCompletion, CommandReservation, ContextProjection, CustomerContext, DemandRecord, OperationReceipt, PlanBasis, ReservationResult, ReserveWorkInput, SnapshotManifest, SyncPlan, WorkLease } from '../types';
import { commandCompletionSchema, commandReservationSchema, contextProjectionSchema, customerContextSchema, demandRecordSchema, reserveWorkInputSchema, snapshotManifestSchema, planBasisSchema, syncPlanSchema, workLeaseSchema } from '../schemas';
import { contextEvidenceRefs, contextValue, renderCustomerContext } from '../context/render';
import { SafeError } from '../../errors';
import type { AgentAnalysis, CustomerCandidates, CatalogSnapshot, ResolutionBundle, SourceRef } from '../types';
import { createAnalysisInputSchema, customerCandidatesSchema, resolutionBundleSchema } from '../schemas';
import { resolveCustomer, uniqueSources, normalizedPhone } from '../identity';
import { resolveDemands } from '../demands';
import { OperationsStore } from '../operations';
import type { OperationInput } from '../operations';
import { automationPolicySchema } from '../policy-types';

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
  private get operations() { return new OperationsStore(this.storage, { reserve: input => this.reserveCommand(input), assert: input => this.checkDispatch(input) }); }
  async prepareOperation(input: OperationInput) { return this.operations.prepareOperation(input); }
  getOperation(id: string) { return this.operations.getOperation(id); }
  getOperationByRequest(id: string) { return this.operations.getOperationByRequest(id); }
  async reserveExecutionCommand(id: string, key: string) { return this.operations.reserveExecutionCommand(id, key); }
  getExecutionCommand(key: string) { return this.operations.getExecutionCommand(key); }
  beginDispatch(id: string, key: string) { return this.operations.beginDispatch(id, key); }
  finishDispatch(...args: Parameters<OperationsStore['finishDispatch']>) { return this.operations.finishDispatch(...args); }
  settleReconciliation(...args: Parameters<OperationsStore['settleReconciliation']>) { return this.operations.settleReconciliation(...args); }
  setOperationStatus(...args: Parameters<OperationsStore['setOperationStatus']>) { return this.operations.setOperationStatus(...args); }
  getExecutionPolicy() {
    const row = this.sql.exec<{ data: string }>('SELECT data FROM policy WHERE singleton = 1').toArray()[0];
    return row ? automationPolicySchema.parse(JSON.parse(row.data)) : undefined;
  }
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
  private checkBasis(basis: PlanBasis): SnapshotManifest {
    this.checkLease(basis.lease);
    const row = this.sql.exec<{ data: string | null; evidence_expires_at: number }>('SELECT data, evidence_expires_at FROM snapshot_manifest WHERE work_id = ?', basis.lease.workId).toArray()[0];
    if (!row?.data || row.evidence_expires_at <= Date.now()) throw Error('SNAPSHOT_REQUIRED');
    const manifest = snapshotManifestSchema.parse(JSON.parse(row.data));
    if (manifest.snapshotVersion !== basis.snapshotVersion || manifest.contextVersion !== basis.contextVersion || manifest.catalogVersion !== basis.catalogVersion) throw Error('STATE_VERSION_CONFLICT');
    if (basis.lease.target.kind === 'customer' && basis.lease.target.customerId !== basis.customerId) throw Error('CONTEXT_CUSTOMER_MISMATCH');
    const customer = this.sql.exec<{ customer_id: string }>('SELECT customer_id FROM work_customers WHERE work_id = ?', basis.lease.workId).toArray()[0];
    if (customer && customer.customer_id !== basis.customerId) throw Error('CONTEXT_CUSTOMER_MISMATCH');
    const current = this.sql.exec<{ version: number }>('SELECT version FROM contexts WHERE customer_id = ?', basis.customerId).toArray()[0];
    if ((current?.version ?? 0) !== basis.contextVersion) throw new SafeError('CONTEXT_STALE', 'Customer context changed; reload and reconcile.', false, 409);
    if (!customer) this.sql.exec('INSERT INTO work_customers VALUES (?, ?)', basis.lease.workId, basis.customerId);
    return manifest;
  }
  private checkDispatch(input: CommandReservation): void {
    const authorization = input.authorization;
    const plan = authorization.plan;
    const policy = this.getExecutionPolicy();
    if (policy && (policy.mode !== 'apply' || policy.version !== plan.policyVersion || input.command.requiredCapabilities.some(c => !policy.capabilities.includes(c)))) throw Error('POLICY_CHANGED');
    const row = this.sql.exec<{ data: string | null; work_id: string; version: number; valid: number; fence: number | null; snapshot_version: number | null; context_version: number | null; catalog_version: string | null; evidence_expires_at: number }>('SELECT * FROM plans WHERE plan_id = ?', plan.planId).toArray()[0];
    if (!row?.valid || !row.data || row.evidence_expires_at <= Date.now() || row.work_id !== input.lease.workId || row.version !== plan.version || row.fence !== input.lease.fence || row.snapshot_version !== input.snapshotVersion || row.context_version !== input.contextVersion || row.catalog_version !== input.catalogVersion || canonical(JSON.parse(row.data)) !== canonical(plan)) throw Error('PLAN_STALE');
    this.checkBasis(input);
    if (input.lease.mode !== 'apply' || plan.state !== 'ready' || plan.reviewIds.length || !plan.orderedCommands.some(command => canonical(command) === canonical(input.command))) throw Error('COMMAND_NOT_AUTHORIZED');
    const actor = authorization.actor;
    const now = Date.now();
    const validUntil = Date.parse(authorization.validUntil);
    if (validUntil <= now || actor.expiresAt === undefined || actor.expiresAt <= now || validUntil > actor.expiresAt) throw Error('AUTHORIZATION_EXPIRED');
    const grants = authorization.commandCapabilities.find(command => command.commandKey === input.command.commandKey)?.capabilities;
    if (actor.userId !== input.lease.owner.userId || actor.clientId !== input.lease.owner.clientId || !actor.scopes.includes('automation:process') || !grants || input.command.requiredCapabilities.some(capability => !grants.includes(capability) || !actor.scopes.includes(capability))) throw Error('COMMAND_NOT_AUTHORIZED');
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
  async savePlan(raw: SyncPlan, rawBasis: PlanBasis): Promise<void> {
    const plan = syncPlanSchema.parse(raw); const basis = planBasisSchema.parse(rawBasis);
    const fingerprint = await digest(plan);
    this.storage.transactionSync(() => {
      if (plan.workId !== basis.lease.workId) throw Error('LEASE_FENCED');
      const manifest = this.checkBasis(basis);
      const sources = manifest.sources;
      for (const ref of [...plan.sourceRefs, ...plan.before.flatMap(f => f.sources), ...plan.after.flatMap(f => f.sources), ...plan.orderedCommands.flatMap(c => [...c.sourceRefs, ...c.before.flatMap(f => f.sources)])]) if (!sources.some(s => canonical(s) === canonical(ref))) throw Error('STALE_SOURCE');
      const previous = this.sql.exec<{ work_id: string; version: number; digest: string; valid: number; fence: number; snapshot_version: number; context_version: number; catalog_version: string }>('SELECT * FROM plans WHERE plan_id = ?', plan.planId).toArray()[0];
      if (previous && previous.work_id !== plan.workId) throw Error('IDEMPOTENCY_CONFLICT');
      if (previous?.version === plan.version && previous.digest === fingerprint && previous.valid && previous.fence === basis.lease.fence && previous.snapshot_version === basis.snapshotVersion && previous.context_version === basis.contextVersion && previous.catalog_version === basis.catalogVersion) return;
      if (plan.version !== (previous?.version ?? 0) + 1) throw Error('VERSION_CONFLICT');
      this.sql.exec('INSERT INTO plans (plan_id, work_id, version, digest, valid, data, evidence_expires_at, fence, snapshot_version, context_version, catalog_version) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?) ON CONFLICT(plan_id) DO UPDATE SET version = excluded.version, digest = excluded.digest, valid = 1, data = excluded.data, evidence_expires_at = excluded.evidence_expires_at, fence = excluded.fence, snapshot_version = excluded.snapshot_version, context_version = excluded.context_version, catalog_version = excluded.catalog_version', plan.planId, plan.workId, plan.version, fingerprint, JSON.stringify(plan), Date.now() + EVIDENCE_RETENTION_MS, basis.lease.fence, basis.snapshotVersion, basis.contextVersion, basis.catalogVersion);
    });
  }
  /** Backend-only resolver. The caller provides a server-created PlanBasis, never an agent customer ID.
   * Reservations survive evidence cleanup and cover different conversations in this account. */
  async resolveWork(rawAnalysis: AgentAnalysis, rawCandidates: CustomerCandidates, catalog: CatalogSnapshot, rawBasis: PlanBasis): Promise<ResolutionBundle> {
    const basis = planBasisSchema.parse(rawBasis);
    const candidates = customerCandidatesSchema.parse({ ...rawCandidates, customerId: basis.customerId });
    const fingerprint = await digest({ analysis: rawAnalysis, candidates, catalogVersion: catalog.version, basis });
    const identityValues: string[] = [];
    for (const fact of rawAnalysis.facts) if (fact.certainty === 'confirmed' && typeof fact.value === 'string') {
      if (fact.field === 'cnpj' && fact.entity === 'organization' && fact.value.replace(/\D/g, '').length === 14) identityValues.push('organization:cnpj:' + fact.value.replace(/\D/g, ''));
      if (fact.field === 'email') identityValues.push(fact.entity + ':email:' + fact.value.trim().toLowerCase());
      if (fact.field === 'phone' && normalizedPhone(fact.value)) identityValues.push('phone:' + normalizedPhone(fact.value));
    }
    if (rawAnalysis.customerSelection.kind !== 'new') identityValues.push(`${rawAnalysis.customerSelection.kind}:${rawAnalysis.customerSelection.id}`);
    else if (!identityValues.length) identityValues.push(`${rawAnalysis.customerSelection.entity}:name-reservation:${rawAnalysis.customerSelection.record.name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR')}`);
    const identities = await Promise.all([...new Set(identityValues)].sort().map(value => digest(value)));
    return this.storage.transactionSync(() => {
      const manifest = this.checkBasis(basis);
      if (catalog.version !== basis.catalogVersion) throw Error('STATE_VERSION_CONFLICT');
      const eventId = `resolution:${basis.lease.workId}:${basis.snapshotVersion}`;
      const previous = this.sql.exec<{ digest: string; data: string | null; evidence_expires_at: number }>('SELECT digest, data, evidence_expires_at FROM events WHERE event_id = ?', eventId).toArray()[0];
      if (previous) {
        if (previous.digest !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT');
        if (!previous.data || previous.evidence_expires_at <= Date.now()) throw Error('RESOLUTION_EVIDENCE_EXPIRED');
        return resolutionBundleSchema.parse(JSON.parse(previous.data));
      }
      const existing = this.sql.exec<{ data: string | null; evidence_expires_at: number }>('SELECT data, evidence_expires_at FROM demands WHERE customer_id = ?', basis.customerId).toArray().filter(r => r.data && r.evidence_expires_at > Date.now()).map(r => demandRecordSchema.parse(JSON.parse(r.data!)));
      const validation = createAnalysisInputSchema({ sourceRefs: manifest.sources.filter((s): s is SourceRef & { kind: 'message' | 'contact' | 'crm' } => s.kind !== 'operator'), candidates: candidates.candidates.map(c => c.ref), existingDemandIds: existing.map(d => d.demandId), catalog }).safeParse({ workId: basis.lease.workId, leaseToken: basis.lease.leaseToken, expectedSnapshotVersion: basis.snapshotVersion, expectedContextVersion: basis.contextVersion, analysis: rawAnalysis });
      if (!validation.success) throw Error('ANALYSIS_INVALID');
      for (const candidate of candidates.candidates) if (!manifest.records.some(r => r.ref.kind === candidate.ref.kind && r.ref.id === candidate.ref.id)) throw Error('CANDIDATE_ABSENT_FROM_SNAPSHOT');
      for (const source of uniqueSources([...candidates.candidates.flatMap(c => c.sourceRefs), ...(candidates.verifiedLinks ?? []).flatMap(l => l.sourceRefs)])) if (!manifest.sources.some(s => canonical(s) === canonical(source))) throw Error('STALE_SOURCE');
      let customer = resolveCustomer(validation.data.analysis, candidates, catalog);
      if (customer.kind !== 'review') {
        const reservations = identities.flatMap(id => this.sql.exec<{ customer_id: string; external_id: string }>('SELECT customer_id, external_id FROM bindings WHERE binding_key = ?', `identity:${id}`).toArray());
        const conflict = reservations.some(row => row.customer_id !== basis.customerId);
        if (conflict) customer = { kind: 'review', sourceRefs: customer.sourceRefs, reviewReasons: ['IDENTITY_RESERVED_FOR_OTHER_CUSTOMER'] };
        else if (customer.kind === 'create' && reservations.some(row => row.external_id !== basis.lease.workId)) customer = { kind: 'review', sourceRefs: customer.sourceRefs, reviewReasons: ['IDENTITY_CREATION_PENDING'] };
      }
      const demands = resolveDemands(validation.data.analysis, customer, existing);
      const bundle = resolutionBundleSchema.parse({ customer, demands });
      if (customer.kind !== 'review') {
        this.sql.exec('INSERT INTO customers VALUES (?, 1) ON CONFLICT(customer_id) DO NOTHING', basis.customerId);
        for (const id of identities) this.sql.exec('INSERT INTO bindings VALUES (?, ?, ?, ?) ON CONFLICT(binding_key) DO NOTHING', `identity:${id}`, basis.customerId, 'identity', basis.lease.workId);
        for (const decision of demands.demands) if (decision.kind === 'create') {
          const request = validation.data.analysis.demands.find(d => d.clientKey === decision.clientKey)!;
          const record: DemandRecord = { demandId: decision.demandId, customerId: basis.customerId, clientKey: request.clientKey, service: request.service, scope: request.scope, state: 'open', sourceRefs: decision.sourceRefs, ...(request.references ? { references: request.references } : {}) };
          const prior = this.sql.exec<{ data: string }>('SELECT data FROM demands WHERE demand_id = ?', record.demandId).toArray()[0];
          if (prior) { const previous = demandRecordSchema.parse(JSON.parse(prior.data)); record.sourceRefs = uniqueSources([...previous.sourceRefs, ...record.sourceRefs]); record.references = [...(previous.references ?? []), ...(record.references ?? [])]; }
          this.sql.exec('INSERT INTO demands VALUES (?, ?, 1, ?, ?) ON CONFLICT(demand_id) DO UPDATE SET data = excluded.data, evidence_expires_at = excluded.evidence_expires_at', record.demandId, basis.customerId, JSON.stringify(record), Date.now() + EVIDENCE_RETENTION_MS);
        }
      }
      this.sql.exec('INSERT INTO events VALUES (?, ?, ?, ?)', eventId, fingerprint, JSON.stringify(bundle), Date.now() + EVIDENCE_RETENTION_MS);
      return bundle;
    });
  }
  getContext(customerId: string): CustomerContext {
    const row = this.sql.exec<{ data: string | null; evidence_expires_at: number }>('SELECT data, evidence_expires_at FROM contexts WHERE customer_id = ? AND valid = 1', customerId).toArray()[0];
    if (!row?.data || row.evidence_expires_at <= Date.now()) throw Error('CONTEXT_UNAVAILABLE');
    return customerContextSchema.parse(JSON.parse(row.data));
  }
  /** Internal structured writer, never exposed as a Markdown upload tool. */
  saveContextProjection(raw: ContextProjection, rawBasis: PlanBasis): void {
    const parsed = contextProjectionSchema.safeParse(raw);
    if (!parsed.success) throw Error('CONTEXT_INVALID');
    const projection = parsed.data; const basis = planBasisSchema.parse(rawBasis);
    this.storage.transactionSync(() => {
      const manifest = this.checkBasis(basis);
      if (basis.customerId !== projection.customerId || projection.demands.some(d => d.customerId !== projection.customerId)) throw Error('CONTEXT_CUSTOMER_MISMATCH');
      const current = this.sql.exec<{ version: number }>('SELECT version FROM contexts WHERE customer_id = ?', projection.customerId).toArray()[0];
      if ((current?.version ?? 0) !== basis.contextVersion || projection.version !== basis.contextVersion + 1) throw new SafeError('CONTEXT_STALE', 'Customer context changed; reload and reconcile.', false, 409);
      for (const ref of contextEvidenceRefs(projection)) if (!manifest.sources.some(s => canonical(s) === canonical(ref))) throw Error('STALE_SOURCE');
      for (const receipt of projection.receipts) {
        const row = this.sql.exec<{ receipt: string; customer_id: string }>('SELECT c.receipt, w.customer_id FROM commands c JOIN work_customers w ON w.work_id = c.work_id WHERE c.command_key = ?', receipt.commandKey).toArray()[0];
        if (!row || row.customer_id !== projection.customerId || canonical(JSON.parse(row.receipt)) !== canonical(receipt)) throw Error('CONTEXT_RECEIPT_UNVERIFIED');
      }
      const factId = 'customer-context:' + projection.customerId;
      const envelope = JSON.stringify({ projection, basis });
      const previous = this.sql.exec<{ data: string | null; valid: number; version: number }>('SELECT data, valid, version FROM facts WHERE fact_id = ?', factId).toArray()[0];
      // Only an unpublished projection owns the pending slot. A rendered version
      // may be superseded by reconciled work from another conversation.
      if (previous?.data && previous.valid && previous.version > (current?.version ?? 0) && contextValue(JSON.parse(previous.data)) !== contextValue(JSON.parse(envelope))) throw new SafeError('CONTEXT_STALE', 'A context projection is awaiting refresh.', false, 409);
      const expires = Date.now() + EVIDENCE_RETENTION_MS;
      this.sql.exec('INSERT INTO facts (fact_id, work_id, version, valid, data, evidence_expires_at) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(fact_id) DO UPDATE SET work_id = excluded.work_id, version = excluded.version, valid = 1, data = excluded.data, evidence_expires_at = excluded.evidence_expires_at', factId, basis.lease.workId, projection.version, envelope, expires);
      for (const demand of projection.demands) {
        const owner = this.sql.exec<{ customer_id: string }>('SELECT customer_id FROM demands WHERE demand_id = ?', demand.demandId).toArray()[0];
        if (owner && owner.customer_id !== projection.customerId) throw Error('CONTEXT_CUSTOMER_MISMATCH');
        this.sql.exec('INSERT INTO demands VALUES (?, ?, ?, ?, ?) ON CONFLICT(demand_id) DO UPDATE SET version = excluded.version, data = excluded.data, evidence_expires_at = excluded.evidence_expires_at', demand.demandId, projection.customerId, projection.version, JSON.stringify(demand), expires);
      }
    });
  }
  refreshCustomerContext(customerId: string, expectedVersion: number): CustomerContext {
    return this.storage.transactionSync(() => {
      const current = this.sql.exec<{ version: number }>('SELECT version FROM contexts WHERE customer_id = ?', customerId).toArray()[0];
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || (current?.version ?? 0) !== expectedVersion) throw new SafeError('CONTEXT_STALE', 'Customer context changed; reload and reconcile.', false, 409);
      const row = this.sql.exec<{ data: string | null; evidence_expires_at: number }>('SELECT data, evidence_expires_at FROM facts WHERE fact_id = ? AND valid = 1', 'customer-context:' + customerId).toArray()[0];
      if (!row?.data || row.evidence_expires_at <= Date.now()) throw Error('CONTEXT_PROJECTION_UNAVAILABLE');
      const stored = JSON.parse(row.data) as { projection: ContextProjection; basis: PlanBasis };
      const projection = contextProjectionSchema.parse(stored.projection); const basis = planBasisSchema.parse(stored.basis);
      if (projection.customerId !== customerId || projection.version !== expectedVersion + 1 || basis.contextVersion !== expectedVersion) throw new SafeError('CONTEXT_STALE', 'Customer context changed; reload and reconcile.', false, 409);
      this.checkBasis(basis);
      // Refresh confirmed results from durable receipts after facts/results committed.
      projection.receipts = this.sql.exec<{ receipt: string }>('SELECT c.receipt FROM commands c JOIN work_customers w ON w.work_id = c.work_id WHERE w.customer_id = ?', customerId).toArray().map(r => JSON.parse(r.receipt) as OperationReceipt);
      const context = customerContextSchema.parse({ customerId, version: projection.version, verifiedAt: projection.verifiedAt, markdown: renderCustomerContext(projection), evidenceRefs: contextEvidenceRefs(projection) });
      this.sql.exec('INSERT INTO contexts VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(customer_id) DO UPDATE SET work_id = excluded.work_id, version = excluded.version, valid = 1, data = excluded.data, evidence_expires_at = excluded.evidence_expires_at', customerId, basis.lease.workId, context.version, JSON.stringify(context), row.evidence_expires_at);
      this.sql.exec('UPDATE plans SET valid = 0 WHERE work_id IN (SELECT work_id FROM work_customers WHERE customer_id = ?)', customerId);
      return context;
    });
  }
  getCustomerDemand(customerId: string, demandId: string): DemandRecord {
    const row = this.sql.exec<{ data: string | null; evidence_expires_at: number }>('SELECT data, evidence_expires_at FROM demands WHERE demand_id = ? AND customer_id = ?', demandId, customerId).toArray()[0];
    if (!row?.data || row.evidence_expires_at <= Date.now()) throw Error('DEMAND_UNAVAILABLE');
    return demandRecordSchema.parse(JSON.parse(row.data));
  }
  async reserveCommand(raw: CommandReservation): Promise<ReservationResult> {
    const input = commandReservationSchema.parse(raw); const fingerprint = await digest({ command: input.command, payloadDigest: input.payloadDigest });
    return this.storage.transactionSync(() => {
      this.checkLease(input.lease);
      const row = this.sql.exec<CommandRow>('SELECT * FROM commands WHERE command_key = ?', input.command.commandKey).toArray()[0];
      if (row) {
        const customer = this.sql.exec<{ customer_id: string }>('SELECT customer_id FROM work_customers WHERE work_id = ?', row.work_id).toArray()[0];
        if (!customer || customer.customer_id !== input.customerId) throw Error('CONTEXT_CUSTOMER_MISMATCH');
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
      this.checkDispatch(input);
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
