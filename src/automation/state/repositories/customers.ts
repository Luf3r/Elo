import { canonical } from '../../../shared/canonical';
import { readJson } from '../../../shared/json';
import { executionCommandSchema, payloadDigest } from '../../operations';
import {
  createAnalysisInputSchema,
  customerCandidatesSchema,
  demandRecordSchema,
  planBasisSchema,
  resolutionBundleSchema,
} from '../../schemas';
import type { WorkflowReview, WorkflowState } from '../../service-state';
import type {
  AgentAnalysis,
  CatalogSnapshot,
  CustomerCandidates,
  DemandRecord,
  PlanBasis,
  ResolutionBundle,
  SnapshotManifest,
  SourceRef,
} from '../../types';
import { EVIDENCE_RETENTION_MS } from './audit';

export interface ResolveWorkTransactionInput {
  rawAnalysis: AgentAnalysis;
  analysis: AgentAnalysis;
  candidates: CustomerCandidates;
  catalog: CatalogSnapshot;
  basis: PlanBasis;
  existingDemands: DemandRecord[];
  reservations: ReadonlyArray<{ customerId: string; workId: string }>;
  pendingReview?: NonNullable<WorkflowState['pendingReview']>;
}

export interface ResolveWorkHooks {
  extractIdentityKeys: (analysis: AgentAnalysis) => string[];
  decide: (input: ResolveWorkTransactionInput) => ResolutionBundle;
}

export interface CustomersDeps {
  checkBasis: (basis: PlanBasis, allowExpired?: boolean) => SnapshotManifest;
  activeReview: (
    basis: PlanBasis,
  ) => { pending: NonNullable<WorkflowState['pendingReview']>; review: WorkflowReview } | undefined;
}

/** Persists customer identity bindings, demand records and atomic work resolution bundles. */
export class CustomersRepository {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly deps: CustomersDeps,
  ) {}

  private get sql() {
    return this.storage.sql;
  }

  /** Backend-only resolver. The caller provides a server-created PlanBasis, never an agent customer ID.
   * Reservations survive evidence cleanup and cover different conversations in this account. */
  async resolveWork(
    rawAnalysis: AgentAnalysis,
    rawCandidates: CustomerCandidates,
    catalog: CatalogSnapshot,
    rawBasis: PlanBasis,
    hooks: ResolveWorkHooks,
  ): Promise<ResolutionBundle> {
    const basis = planBasisSchema.parse(rawBasis);
    const candidates = customerCandidatesSchema.parse({ ...rawCandidates, customerId: basis.customerId });
    const fingerprint = await payloadDigest({
      analysis: rawAnalysis,
      candidates,
      catalogVersion: catalog.version,
      basis,
    });
    const identities = await Promise.all(hooks.extractIdentityKeys(rawAnalysis).map((value) => payloadDigest(value)));
    return this.storage.transactionSync(() => {
      const manifest = this.deps.checkBasis(basis);
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
        return readJson(resolutionBundleSchema, previous.data, 'events.data');
      }
      const existing = this.sql
        .exec<{ data: string | null; evidence_expires_at: number }>(
          'SELECT data, evidence_expires_at FROM demands WHERE customer_id = ?',
          basis.customerId,
        )
        .toArray()
        .filter((r) => r.data && r.evidence_expires_at > Date.now())
        .map((r) => readJson(demandRecordSchema, r.data!, 'demands.data'));
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
      for (const source of [
        ...candidates.candidates.flatMap((c) => c.sourceRefs),
        ...(candidates.verifiedLinks ?? []).flatMap((l) => l.sourceRefs),
      ])
        if (!manifest.sources.some((s) => canonical(s) === canonical(source))) throw Error('STALE_SOURCE');
      const reviewed = this.deps.activeReview(basis);
      const reservations = identities.flatMap((id) =>
        this.sql
          .exec<{ customer_id: string; external_id: string }>(
            'SELECT customer_id, external_id FROM bindings WHERE binding_key = ?',
            `identity:${id}`,
          )
          .toArray()
          .map((row) => ({ customerId: row.customer_id, workId: row.external_id })),
      );
      const bundle = resolutionBundleSchema.parse(
        hooks.decide({
          rawAnalysis,
          analysis: validation.data.analysis,
          candidates,
          catalog,
          basis,
          existingDemands: existing,
          reservations,
          pendingReview: reviewed?.pending,
        }),
      );
      const { customer, demands } = bundle;
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
              const previousRecord = readJson(demandRecordSchema, prior.data, 'demands.data');
              record.dealRef = previousRecord.dealRef;
              record.state = previousRecord.state;
              record.references = [
                ...new Map(
                  [...(previousRecord.references ?? []), ...(record.references ?? [])].map((r) => [
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

  getCustomerDemand(customerId: string, demandId: string): DemandRecord {
    const row = this.sql
      .exec<{ data: string | null; evidence_expires_at: number }>(
        'SELECT data, evidence_expires_at FROM demands WHERE demand_id = ? AND customer_id = ?',
        demandId,
        customerId,
      )
      .toArray()[0];
    if (!row?.data || row.evidence_expires_at <= Date.now()) throw Error('DEMAND_UNAVAILABLE');
    return readJson(demandRecordSchema, row.data, 'demands.data');
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
      .map((r) => readJson(demandRecordSchema, r.data!, 'demands.data'));
    const commands = this.sql
      .exec<{ data: string }>(
        'SELECT e.data FROM execution_commands e JOIN commands c ON e.command_key = c.command_key JOIN work_customers w ON c.work_id = w.work_id WHERE w.customer_id = ? LIMIT 501',
        customerId,
      )
      .toArray()
      .map((r) => readJson(executionCommandSchema, r.data, 'execution_commands.data'))
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
}
