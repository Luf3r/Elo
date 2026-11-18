import { canonical } from '../../../shared/canonical';
import { readJson } from '../../../shared/json';
import { OperationsStore, payloadDigest, type OperationInput } from '../../operations';
import {
  commandCompletionSchema,
  commandReservationSchema,
  operationReceiptSchema,
  syncPlanSchema,
} from '../../schemas';
import type { WorkflowReview, WorkflowState } from '../../service-state';
import type {
  AutomationPolicy,
  CommandCompletion,
  CommandReservation,
  OperationReceipt,
  PlanBasis,
  ReservationResult,
  SnapshotManifest,
  WorkLease,
} from '../../types';
import type { WorkRow } from './work';

type CommandRow = {
  command_key: string;
  operation_id: string;
  work_id: string;
  digest: string;
  fence: number;
  version: number;
  state: OperationReceipt['state'];
  receipt: string;
};

export interface CommandsDeps {
  getWork: (id: string) => WorkRow | undefined;
  liveWork: (id: string) => WorkRow;
  checkLease: (lease: WorkLease) => WorkRow;
  checkBasis: (basis: PlanBasis, allowExpired?: boolean) => SnapshotManifest;
  getWorkflow: (workId: string) => WorkflowState | undefined;
  getExecutionPolicy: () => AutomationPolicy | undefined;
  putReview: (review: WorkflowReview) => void;
}

/** Manages execution operations, dispatch authorization checks and command reservations. */
export class CommandsRepository {
  private readonly store: OperationsStore;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly deps: CommandsDeps,
  ) {
    this.store = new OperationsStore(this.storage, {
      reserve: (input) => this.reserveCommand(input),
      assert: (input) => this.checkDispatch(input),
    });
  }

  private get sql() {
    return this.storage.sql;
  }

  async prepareOperation(input: OperationInput) {
    return this.store.prepareOperation(input);
  }

  getOperation(id: string) {
    return this.store.getOperation(id);
  }

  getOperationByRequest(id: string) {
    return this.store.getOperationByRequest(id);
  }

  async reserveExecutionCommand(id: string, key: string) {
    return this.store.reserveExecutionCommand(id, key);
  }

  getExecutionCommand(key: string) {
    return this.store.getExecutionCommand(key);
  }

  beginDispatch(id: string, key: string) {
    return this.store.beginDispatch(id, key);
  }

  finishDispatch(...args: Parameters<OperationsStore['finishDispatch']>) {
    return this.store.finishDispatch(...args);
  }

  settleReconciliation(...args: Parameters<OperationsStore['settleReconciliation']>) {
    return this.store.settleReconciliation(...args);
  }

  setOperationStatus(...args: Parameters<OperationsStore['setOperationStatus']>) {
    return this.storage.transactionSync(() => {
      const status = this.store.setOperationStatus(...args);
      const operation = this.store.getOperation(args[0]);
      if (operation && (status.state === 'review' || status.state === 'authorization_expired'))
        this.deps.putReview({
          reviewId: 'operation-review:' + operation.operationId,
          workId: operation.input.basis.lease.workId,
          customerId: operation.input.basis.customerId,
          version: 1,
          owner: operation.input.basis.lease.owner,
          state: 'open',
          reasons: status.pendingReasons.length ? status.pendingReasons : ['COMMAND_REQUIRES_REVIEW'],
        });
      return status;
    });
  }

  hasCommandKey(key: string): boolean {
    return this.sql.exec('SELECT command_key FROM commands WHERE command_key = ?', key).toArray().length > 0;
  }

  checkDispatch(input: CommandReservation): void {
    const authorization = input.authorization;
    const plan = authorization.plan;
    const policy = this.deps.getExecutionPolicy();
    const direct = this.deps.getWorkflow(input.lease.workId)?.direct;
    if (
      direct &&
      (canonical(direct.command) !== canonical(input.command) ||
        input.command.requiredCapabilities.length !== 1 ||
        input.command.requiredCapabilities[0] !== direct.capability)
    )
      throw Error('COMMAND_NOT_AUTHORIZED');
    if (
      !direct &&
      policy &&
      (policy.mode !== 'apply' ||
        policy.version !== plan.policyVersion ||
        input.command.requiredCapabilities.some((c) => !policy.capabilities.includes(c)))
    )
      throw Error('POLICY_CHANGED');
    const row = this.sql
      .exec<{
        data: string | null;
        work_id: string;
        version: number;
        valid: number;
        fence: number | null;
        snapshot_version: number | null;
        context_version: number | null;
        catalog_version: string | null;
        evidence_expires_at: number;
      }>('SELECT * FROM plans WHERE plan_id = ?', plan.planId)
      .toArray()[0];
    if (
      !row?.valid ||
      !row.data ||
      row.evidence_expires_at <= Date.now() ||
      row.work_id !== input.lease.workId ||
      row.version !== plan.version ||
      row.fence !== input.lease.fence ||
      row.snapshot_version !== input.snapshotVersion ||
      row.context_version !== input.contextVersion ||
      row.catalog_version !== input.catalogVersion ||
      canonical(readJson(syncPlanSchema, row.data, 'plans.data')) !== canonical(plan)
    )
      throw Error('PLAN_STALE');
    this.deps.checkBasis(input);
    if (
      input.lease.mode !== 'apply' ||
      plan.state !== 'ready' ||
      plan.reviewIds.length ||
      !plan.orderedCommands.some((command) => canonical(command) === canonical(input.command))
    )
      throw Error('COMMAND_NOT_AUTHORIZED');
    const actor = authorization.actor;
    const now = Date.now();
    const validUntil = Date.parse(authorization.validUntil);
    if (validUntil <= now || actor.expiresAt === undefined || actor.expiresAt <= now || validUntil > actor.expiresAt)
      throw Error('AUTHORIZATION_EXPIRED');
    const grants = authorization.commandCapabilities.find(
      (command) => command.commandKey === input.command.commandKey,
    )?.capabilities;
    if (
      actor.userId !== input.lease.owner.userId ||
      actor.clientId !== input.lease.owner.clientId ||
      (!direct && !actor.scopes.includes('automation:process')) ||
      !grants ||
      input.command.requiredCapabilities.some(
        (capability) => !grants.includes(capability) || !actor.scopes.includes(capability),
      )
    )
      throw Error('COMMAND_NOT_AUTHORIZED');
  }

  async reserveCommand(raw: CommandReservation): Promise<ReservationResult> {
    const input = commandReservationSchema.parse(raw);
    const fingerprint = await payloadDigest({ command: input.command, payloadDigest: input.payloadDigest });
    return this.storage.transactionSync(() => {
      this.deps.checkLease(input.lease);
      const row = this.sql
        .exec<CommandRow>('SELECT * FROM commands WHERE command_key = ?', input.command.commandKey)
        .toArray()[0];
      if (row) {
        const customer = this.sql
          .exec<{ customer_id: string }>('SELECT customer_id FROM work_customers WHERE work_id = ?', row.work_id)
          .toArray()[0];
        if (!customer || customer.customer_id !== input.customerId) throw Error('CONTEXT_CUSTOMER_MISMATCH');
        if (row.digest !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT');
        const receipt = readJson(operationReceiptSchema, row.receipt, 'commands.receipt');
        if (row.state === 'confirmed') return { state: 'already_confirmed', version: row.version, receipt };
        if (row.state === 'uncertain') return { state: 'uncertain', version: row.version, receipt };
        if (row.state === 'rejected' || row.state === 'review')
          return { state: 'review', version: row.version, reviewReasons: ['command_requires_review'] };
        const work = this.deps.getWork(row.work_id);
        if (!work || work.expires_at <= Date.now() || row.fence !== work.fence) {
          receipt.state = 'uncertain';
          this.sql.exec(
            'UPDATE commands SET state = ?, receipt = ?, version = version + 1 WHERE command_key = ?',
            'uncertain',
            JSON.stringify(receipt),
            row.command_key,
          );
          return { state: 'uncertain', version: row.version + 1, receipt };
        }
        return { state: 'busy', version: row.version };
      }
      this.checkDispatch(input);
      if (input.expectedVersion !== 1) throw Error('VERSION_CONFLICT');
      const receipt: OperationReceipt = {
        operationId: input.operationId,
        commandKey: input.command.commandKey,
        state: 'reserved',
        updatedFields: [],
      };
      this.sql.exec(
        'INSERT INTO commands VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
        input.command.commandKey,
        input.operationId,
        input.lease.workId,
        fingerprint,
        input.lease.fence,
        'reserved',
        JSON.stringify(receipt),
      );
      return { state: 'reserved', version: 1, fence: input.lease.fence };
    });
  }

  completeCommand(raw: CommandCompletion): void {
    const input = commandCompletionSchema.parse(raw);
    this.storage.transactionSync(() => {
      const row = this.sql
        .exec<CommandRow>('SELECT * FROM commands WHERE command_key = ?', input.commandKey)
        .toArray()[0];
      if (!row || row.fence !== input.fence) throw Error('LEASE_FENCED');
      const work = this.deps.liveWork(row.work_id);
      if (work.fence !== input.fence) throw Error('LEASE_FENCED');
      if (
        row.version !== input.expectedVersion ||
        row.operation_id !== input.operationId ||
        input.receipt.operationId !== input.operationId ||
        input.receipt.commandKey !== input.commandKey
      )
        throw Error('VERSION_CONFLICT');
      if (
        !['reserved', 'running'].includes(row.state) ||
        !['confirmed', 'uncertain', 'rejected', 'review'].includes(input.receipt.state)
      )
        throw Error('INVALID_COMMAND_TRANSITION');
      this.sql.exec(
        'UPDATE commands SET state = ?, receipt = ?, version = version + 1 WHERE command_key = ? AND version = ? AND fence = ?',
        input.receipt.state,
        JSON.stringify(input.receipt),
        input.commandKey,
        input.expectedVersion,
        input.fence,
      );
    });
  }
}
