import { z } from 'zod';
import { canonical } from '../../../shared/canonical';
import { SafeError } from '../../../shared/errors';
import { readJson } from '../../../shared/json';
import type { ExecutionCommand, ExecutionOperation } from '../../operations';
import {
  contextProjectionEnvelopeSchema,
  contextProjectionSchema,
  customerContextSchema,
  operationReceiptSchema,
  planBasisSchema,
  sourceRefSchema,
} from '../../schemas';
import type { WorkflowState } from '../../service-state';
import type { ContextProjection, CustomerContext, PlanBasis, SnapshotManifest, SourceRef } from '../../types';
import { EVIDENCE_RETENTION_MS } from './audit';

export interface ContextRenderOutput {
  markdown: string;
  evidenceRefs: SourceRef[];
}

export type ContextRenderer = (projection: ContextProjection) => ContextRenderOutput;
export type ContextEvidenceExtractor = (projection: ContextProjection) => SourceRef[];

export interface ContextDeps {
  checkBasis: (basis: PlanBasis, allowExpired?: boolean) => SnapshotManifest;
  getWorkflow: (workId: string) => WorkflowState | undefined;
  getOperation: (id: string) => ExecutionOperation | undefined;
  getExecutionCommand: (key: string) => ExecutionCommand | undefined;
}

/** Manages customer context projections, durable rendering and operation context publication. */
export class ContextRepository {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly deps: ContextDeps,
  ) {}

  private get sql() {
    return this.storage.sql;
  }

  getContextConversationIds(customerId: string, limit: number): number[] {
    const row = this.sql
      .exec<{ refs: string | null }>(
        "SELECT json_extract(data, '$.evidenceRefs') AS refs FROM contexts WHERE customer_id = ? AND valid = 1 AND evidence_expires_at > ?",
        customerId,
        Date.now(),
      )
      .toArray()[0];
    const refs = row?.refs ? readJson(z.array(sourceRefSchema), row.refs, 'contexts.evidenceRefs') : [];
    const ids = refs.flatMap((ref) =>
      ref.kind === 'message' && /^[1-9][0-9]*:[1-9][0-9]*$/.test(ref.id) ? [Number(ref.id.split(':')[0])] : [],
    );
    return [...new Set(ids)].filter((id) => Number.isSafeInteger(id)).slice(0, limit);
  }

  getContext(customerId: string): CustomerContext {
    const row = this.sql
      .exec<{ data: string | null; evidence_expires_at: number }>(
        'SELECT data, evidence_expires_at FROM contexts WHERE customer_id = ? AND valid = 1',
        customerId,
      )
      .toArray()[0];
    if (!row?.data || row.evidence_expires_at <= Date.now()) throw Error('CONTEXT_UNAVAILABLE');
    return readJson(customerContextSchema, row.data, 'contexts.data');
  }

  /** Internal structured writer, never exposed as a Markdown upload tool. */
  saveContextProjection(
    raw: ContextProjection,
    rawBasis: PlanBasis,
    extractEvidenceRefs: ContextEvidenceExtractor,
  ): void {
    const parsed = contextProjectionSchema.safeParse(raw);
    if (!parsed.success) throw Error('CONTEXT_INVALID');
    let projection = parsed.data;
    const basis = planBasisSchema.parse(rawBasis);
    this.storage.transactionSync(() => {
      const manifest = this.deps.checkBasis(basis);
      if (
        basis.customerId !== projection.customerId ||
        projection.demands.some((d) => d.customerId !== projection.customerId)
      )
        throw Error('CONTEXT_CUSTOMER_MISMATCH');
      const current = this.sql
        .exec<{ version: number }>('SELECT version FROM contexts WHERE customer_id = ?', projection.customerId)
        .toArray()[0];
      if ((current?.version ?? 0) !== basis.contextVersion || projection.version !== basis.contextVersion + 1)
        throw new SafeError('CONTEXT_STALE', 'Customer context changed; reload and reconcile.', false, 409);
      for (const ref of extractEvidenceRefs(projection))
        if (!manifest.sources.some((s) => canonical(s) === canonical(ref))) throw Error('STALE_SOURCE');
      for (const receipt of projection.receipts) {
        const row = this.sql
          .exec<{ receipt: string; customer_id: string }>(
            'SELECT c.receipt, w.customer_id FROM commands c JOIN work_customers w ON w.work_id = c.work_id WHERE c.command_key = ?',
            receipt.commandKey,
          )
          .toArray()[0];
        if (
          !row ||
          row.customer_id !== projection.customerId ||
          canonical(readJson(operationReceiptSchema, row.receipt, 'commands.receipt')) !== canonical(receipt)
        )
          throw Error('CONTEXT_RECEIPT_UNVERIFIED');
      }
      const factId = 'customer-context:' + projection.customerId;
      const previous = this.sql
        .exec<{ data: string | null; valid: number; version: number }>(
          'SELECT data, valid, version FROM facts WHERE fact_id = ?',
          factId,
        )
        .toArray()[0];
      // Only an unpublished projection owns the pending slot. A rendered version
      // may be superseded by reconciled work from another conversation.
      if (previous?.data && previous.valid && previous.version > (current?.version ?? 0)) {
        const stored = readJson(contextProjectionEnvelopeSchema, previous.data, 'facts.data');
        if (
          canonical(stored.basis) === canonical(basis) &&
          canonical({ ...stored.projection, verifiedAt: projection.verifiedAt }) === canonical(projection)
        )
          return;
        throw new SafeError('CONTEXT_STALE', 'A context projection is awaiting refresh.', false, 409);
      }
      // Retain canonical facts from the last published version even when this
      // conversation does not repeat them. Only the stored structured envelope
      // can carry historical sources; new facts above require this manifest.
      if (previous?.data && previous.valid && previous.version === basis.contextVersion) {
        const prior = readJson(contextProjectionEnvelopeSchema, previous.data, 'facts.data').projection;
        const replacementKeys = new Set(
          projection.facts.filter((f) => f.certainty === 'confirmed').map((f) => `${f.entity}:${f.field}`),
        );
        const corrections = prior.facts.flatMap((old) => {
          const replacement = projection.facts.find(
            (f) =>
              f.certainty === 'confirmed' &&
              f.entity === old.entity &&
              f.field === old.field &&
              canonical(f.value) !== canonical(old.value),
          );
          return old.certainty === 'confirmed' && replacement ? [{ previous: old, replacement }] : [];
        });
        const unique = <T>(values: T[], key: (value: T) => string): T[] => [
          ...new Map(values.map((value) => [key(value), value])).values(),
        ];
        projection = contextProjectionSchema.parse({
          ...projection,
          primaryRef: projection.primaryRef ?? prior.primaryRef,
          facts: unique(
            [...prior.facts.filter((f) => !replacementKeys.has(`${f.entity}:${f.field}`)), ...projection.facts],
            canonical,
          ),
          contacts: unique([...prior.contacts, ...projection.contacts], (c) => canonical(c.ref)),
          demands: unique([...prior.demands, ...projection.demands], (d) => d.demandId),
          pendingReasons: [...new Set([...prior.pendingReasons, ...projection.pendingReasons])],
          corrections: unique(
            [...(prior.corrections ?? []), ...(projection.corrections ?? []), ...corrections],
            canonical,
          ),
        });
      }
      const expires = Date.now() + EVIDENCE_RETENTION_MS;
      this.sql.exec(
        'INSERT INTO facts (fact_id, work_id, version, valid, data, evidence_expires_at) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(fact_id) DO UPDATE SET work_id = excluded.work_id, version = excluded.version, valid = 1, data = excluded.data, evidence_expires_at = excluded.evidence_expires_at',
        factId,
        basis.lease.workId,
        projection.version,
        JSON.stringify({ projection, basis }),
        expires,
      );
      for (const demand of projection.demands) {
        const owner = this.sql
          .exec<{ customer_id: string }>('SELECT customer_id FROM demands WHERE demand_id = ?', demand.demandId)
          .toArray()[0];
        if (owner && owner.customer_id !== projection.customerId) throw Error('CONTEXT_CUSTOMER_MISMATCH');
        this.sql.exec(
          'INSERT INTO demands VALUES (?, ?, ?, ?, ?) ON CONFLICT(demand_id) DO UPDATE SET version = excluded.version, data = excluded.data, evidence_expires_at = excluded.evidence_expires_at',
          demand.demandId,
          projection.customerId,
          projection.version,
          JSON.stringify(demand),
          expires,
        );
      }
    });
  }

  refreshCustomerContext(
    customerId: string,
    expectedVersion: number,
    renderContext: ContextRenderer,
    allowExpired = false,
  ): CustomerContext {
    return this.storage.transactionSync(() => {
      const current = this.sql
        .exec<{ version: number }>('SELECT version FROM contexts WHERE customer_id = ?', customerId)
        .toArray()[0];
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || (current?.version ?? 0) !== expectedVersion)
        throw new SafeError('CONTEXT_STALE', 'Customer context changed; reload and reconcile.', false, 409);
      const row = this.sql
        .exec<{ data: string | null; evidence_expires_at: number }>(
          'SELECT data, evidence_expires_at FROM facts WHERE fact_id = ? AND valid = 1',
          'customer-context:' + customerId,
        )
        .toArray()[0];
      if (!row?.data || row.evidence_expires_at <= Date.now()) throw Error('CONTEXT_PROJECTION_UNAVAILABLE');
      const stored = readJson(contextProjectionEnvelopeSchema, row.data, 'facts.data');
      const projection = stored.projection;
      const basis = stored.basis;
      if (
        projection.customerId !== customerId ||
        projection.version !== expectedVersion + 1 ||
        basis.contextVersion !== expectedVersion
      )
        throw new SafeError('CONTEXT_STALE', 'Customer context changed; reload and reconcile.', false, 409);
      this.deps.checkBasis(basis, allowExpired);
      // Refresh confirmed results from durable receipts after facts/results committed.
      projection.receipts = this.sql
        .exec<{ receipt: string }>(
          'SELECT c.receipt FROM commands c JOIN work_customers w ON w.work_id = c.work_id WHERE w.customer_id = ?',
          customerId,
        )
        .toArray()
        .map((r) => readJson(operationReceiptSchema, r.receipt, 'commands.receipt'));
      const rendered = renderContext(projection);
      const context = customerContextSchema.parse({
        customerId,
        version: projection.version,
        verifiedAt: projection.verifiedAt,
        markdown: rendered.markdown,
        evidenceRefs: rendered.evidenceRefs,
      });
      this.sql.exec(
        'INSERT INTO contexts VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(customer_id) DO UPDATE SET work_id = excluded.work_id, version = excluded.version, valid = 1, data = excluded.data, evidence_expires_at = excluded.evidence_expires_at',
        customerId,
        basis.lease.workId,
        context.version,
        JSON.stringify(context),
        row.evidence_expires_at,
      );
      this.sql.exec(
        'UPDATE plans SET valid = 0 WHERE work_id IN (SELECT work_id FROM work_customers WHERE customer_id = ?)',
        customerId,
      );
      return context;
    });
  }

  publishOperationContext(id: string, renderContext: ContextRenderer): void {
    this.storage.transactionSync(() => {
      const operation = this.deps.getOperation(id);
      if (!operation || operation.status.state !== 'applied') return;
      const basis = operation.input.basis;
      if (this.deps.getWorkflow(basis.lease.workId)?.direct) {
        this.completeDirectOperation(id);
        return;
      }
      const current = this.sql
        .exec<{ version: number }>('SELECT version FROM contexts WHERE customer_id = ?', basis.customerId)
        .toArray()[0];
      if ((current?.version ?? 0) > basis.contextVersion) return;
      const pending = this.sql
        .exec<{ data: string | null }>(
          'SELECT data FROM facts WHERE fact_id = ? AND valid = 1',
          'customer-context:' + basis.customerId,
        )
        .toArray()[0];
      if (!pending?.data) return;
      const envelope = readJson(contextProjectionEnvelopeSchema, pending.data, 'facts.data');
      if (canonical(envelope.basis) !== canonical(basis)) throw Error('CONTEXT_STALE');
      for (const command of operation.input.authorization.plan.orderedCommands) {
        const receipt = this.deps.getExecutionCommand(command.commandKey)?.receipt;
        if (receipt?.state !== 'confirmed' || !receipt.checkedAt || !receipt.crmRef) continue;
        if (
          (command.kind === 'create_person' || command.kind === 'create_organization') &&
          receipt.crmRef.kind === (command.kind === 'create_person' ? 'person' : 'organization')
        ) {
          envelope.projection.primaryRef = { kind: receipt.crmRef.kind, id: receipt.crmRef.id };
          const bindingKey = `confirmed-crm:${receipt.crmRef.kind}:${receipt.crmRef.id}`;
          const bound = this.sql
            .exec<{ customer_id: string }>('SELECT customer_id FROM bindings WHERE binding_key = ?', bindingKey)
            .toArray()[0];
          if (bound && bound.customer_id !== basis.customerId) throw Error('CUSTOMER_BINDING_CONFLICT');
          this.sql.exec(
            'INSERT INTO bindings VALUES (?, ?, ?, ?) ON CONFLICT(binding_key) DO NOTHING',
            bindingKey,
            basis.customerId,
            'confirmed-crm',
            String(receipt.crmRef.id),
          );
        }
        if (command.kind === 'create_deal' && receipt.crmRef.kind === 'deal') {
          const demand = envelope.projection.demands.find((d) => command.commandKey === `deal:${d.demandId}`);
          if (demand) {
            demand.dealRef = { kind: 'deal', id: receipt.crmRef.id };
            this.sql.exec(
              'UPDATE demands SET data = ? WHERE demand_id = ? AND customer_id = ?',
              JSON.stringify(demand),
              demand.demandId,
              basis.customerId,
            );
          }
        }
      }
      envelope.projection.pendingPlanIds = (envelope.projection.pendingPlanIds ?? []).filter(
        (planId) => planId !== operation.input.authorization.plan.planId,
      );
      this.sql.exec(
        'UPDATE facts SET data = ? WHERE fact_id = ?',
        JSON.stringify(envelope),
        'customer-context:' + basis.customerId,
      );
      this.refreshCustomerContext(basis.customerId, basis.contextVersion, renderContext, true);
    });
  }

  completeDirectOperation(id: string): void {
    const operation = this.deps.getOperation(id);
    if (
      !operation ||
      operation.status.state !== 'applied' ||
      !this.deps.getWorkflow(operation.input.basis.lease.workId)?.direct
    )
      return;
    this.sql.exec(
      'UPDATE work SET expires_at = ? WHERE work_id = ? AND fence = ?',
      Date.now(),
      operation.input.basis.lease.workId,
      operation.input.basis.lease.fence,
    );
  }
}
