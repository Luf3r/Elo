import { z } from 'zod';
import { authorizedPlanSchema, planBasisSchema, operationStatusSchema } from './schemas';
import type { CommandReservation, MutationCommand, OperationReceipt, OperationStatus, ReservationResult } from './types';

export const operationInputSchema = z.strictObject({ requestId: z.string().min(1).max(200), accountKey: z.literal('elotenant'), authorization: authorizedPlanSchema, basis: planBasisSchema,
  catalogJson: z.string().min(2).max(1_048_576) });
export type OperationInput = z.infer<typeof operationInputSchema>;
export interface ExecutionOperation { operationId: string; version: number; input: OperationInput; status: OperationStatus; createdAt: number; authorizedAt: number }
export interface ExecutionCommand { operationId: string; command: MutationCommand; state: 'ready' | 'sending' | 'retry' | 'confirmed' | 'uncertain' | 'review'; attempts: number; nextAttemptAt: number; token?: string; receipt: OperationReceipt; fence: number; reservationVersion: number }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export async function payloadDigest(value: unknown): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))))].map(v => v.toString(16).padStart(2, '0')).join('');
}
interface Hooks { reserve(input: CommandReservation): Promise<ReservationResult>; assert(input: CommandReservation): void }

/** SQL state and Task 6 reservations share one account. Sending claims never
 * expire into permission to resend: an abandoned claim can only be read back. */
export class OperationsStore {
  constructor(private readonly storage: DurableObjectStorage, private readonly hooks: Hooks) {}
  private get sql() { return this.storage.sql; }
  getOperation(operationId: string): ExecutionOperation | undefined {
    const row = this.sql.exec<{ data: string }>('SELECT data FROM execution_operations WHERE operation_id = ?', operationId).toArray()[0];
    return row ? JSON.parse(row.data) as ExecutionOperation : undefined;
  }
  getOperationByRequest(requestId: string) {
    const row = this.sql.exec<{ operation_id: string }>('SELECT operation_id FROM execution_operations WHERE request_id = ?', requestId).toArray()[0];
    return row ? this.getOperation(row.operation_id) : undefined;
  }
  async prepareOperation(raw: OperationInput): Promise<ExecutionOperation> {
    const input = operationInputSchema.parse(raw);
    if (input.basis.lease.mode !== 'apply') throw Error('PREVIEW_APPLY_REJECTED');
    if (input.authorization.plan.workId !== input.basis.lease.workId || input.authorization.plan.state === 'review') throw Error('PLAN_STALE');
    const fingerprint = await payloadDigest({ plan: input.authorization.plan, basis: input.basis, actor: { userId: input.authorization.actor.userId, clientId: input.authorization.actor.clientId, scopes: input.authorization.actor.scopes }, catalogJson: input.catalogJson });
    return this.storage.transactionSync(() => {
      const prior = this.sql.exec<{ digest: string; operation_id: string }>('SELECT digest, operation_id FROM execution_operations WHERE request_id = ?', input.requestId).toArray()[0];
      if (prior) {
        if (prior.digest !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT');
        const previous = this.getOperation(prior.operation_id)!;
        const until = Date.parse(input.authorization.validUntil); const now = Date.now();
        if (until > Date.parse(previous.input.authorization.validUntil) && until > now && until <= now + 300_000 && input.authorization.actor.expiresAt !== undefined && until <= input.authorization.actor.expiresAt) {
          previous.input.authorization = input.authorization; previous.authorizedAt = now;
          this.sql.exec('UPDATE execution_operations SET data = ? WHERE operation_id = ?', JSON.stringify(previous), previous.operationId);
        }
        return previous;
      }
      const operationId = crypto.randomUUID();
      const record: ExecutionOperation = { operationId, version: 1, input, createdAt: Date.now(), authorizedAt: Date.now(), status: { operationId, state: 'queued', receipts: [], pendingReasons: [] } };
      this.sql.exec('INSERT INTO execution_operations VALUES (?, ?, ?, ?)', operationId, input.requestId, fingerprint, JSON.stringify(record));
      return record;
    });
  }
  getExecutionCommand(commandKey: string): ExecutionCommand | undefined {
    const row = this.sql.exec<{ data: string; next_attempt_at: number }>('SELECT data, next_attempt_at FROM execution_commands WHERE command_key = ?', commandKey).toArray()[0];
    return row ? { ...JSON.parse(row.data) as ExecutionCommand, nextAttemptAt: row.next_attempt_at } : undefined;
  }
  private putCommand(record: ExecutionCommand) {
    this.sql.exec('INSERT INTO execution_commands VALUES (?, ?, ?, ?) ON CONFLICT(command_key) DO UPDATE SET data = excluded.data, next_attempt_at = excluded.next_attempt_at', record.command.commandKey, record.operationId, record.nextAttemptAt, JSON.stringify(record));
  }
  private reservation(operation: ExecutionOperation, command: MutationCommand): CommandReservation {
    // Task 6 hashes the complete command independently; this domain tag is not
    // a caller-supplied substitute for its payload fingerprint.
    return { ...operation.input.basis, authorization: operation.input.authorization, command, operationId: operation.operationId, expectedVersion: 1, payloadDigest: 'execution-v1' };
  }
  async reserveExecutionCommand(operationId: string, commandKey: string): Promise<ExecutionCommand> {
    const operation = this.getOperation(operationId); if (!operation) throw Error('OPERATION_UNAVAILABLE');
    const command = operation.input.authorization.plan.orderedCommands.find(c => c.commandKey === commandKey); if (!command) throw Error('COMMAND_NOT_AUTHORIZED');
    const previous = this.getExecutionCommand(commandKey);
    if (previous) {
      if (canonical(command) !== canonical(previous.command)) throw Error('IDEMPOTENCY_CONFLICT');
      if (previous.operationId !== operationId) throw Error('COMMAND_OWNED_BY_OTHER_OPERATION');
      return previous;
    }
    const reservation = await this.hooks.reserve(this.reservation(operation, command));
    return this.storage.transactionSync(() => {
      const raced = this.getExecutionCommand(commandKey); if (raced) return raced;
      const record: ExecutionCommand = { operationId, command, state: reservation.state === 'reserved' ? 'ready' : reservation.state === 'already_confirmed' ? 'confirmed' : reservation.state === 'uncertain' || reservation.state === 'busy' ? 'uncertain' : 'review', attempts: 0, nextAttemptAt: 0, receipt: 'receipt' in reservation ? reservation.receipt : { operationId, commandKey, state: reservation.state === 'reserved' ? 'reserved' : 'uncertain', updatedFields: [] }, fence: 'fence' in reservation ? reservation.fence : operation.input.basis.lease.fence, reservationVersion: reservation.version };
      this.putCommand(record); return record;
    });
  }
  beginDispatch(operationId: string, commandKey: string): ExecutionCommand | undefined {
    return this.storage.transactionSync(() => {
      const operation = this.getOperation(operationId); const command = this.getExecutionCommand(commandKey);
      if (!operation || !command || command.operationId !== operationId) throw Error('OPERATION_UNAVAILABLE');
      if (!['ready', 'retry'].includes(command.state) || command.nextAttemptAt > Date.now()) return;
      if (command.attempts >= 5) { command.state = 'review'; command.receipt.state = 'review'; this.putCommand(command); return; }
      this.hooks.assert(this.reservation(operation, command.command));
      if (Date.parse(operation.input.authorization.validUntil) > operation.authorizedAt + 300_000) throw Error('AUTHORIZATION_EXPIRED');
      for (const dependency of command.command.dependencies) {
        const parent = this.getExecutionCommand(dependency);
        if (!parent || parent.operationId !== operationId || parent.state !== 'confirmed') throw Error('DEPENDENCY_NOT_CONFIRMED');
      }
      command.state = 'sending'; command.attempts++; command.token = crypto.randomUUID(); command.receipt.state = 'running';
      // This deadline grants read-only recovery; it never grants another send.
      command.nextAttemptAt = Date.now() + 30_000;
      this.putCommand(command); return command;
    });
  }
  finishDispatch(commandKey: string, token: string, result: { state: 'confirmed' | 'uncertain' | 'review' | 'retry'; receipt: OperationReceipt; retryAt?: number }): void {
    this.storage.transactionSync(() => {
      const command = this.getExecutionCommand(commandKey);
      if (!command || command.token !== token || command.state !== 'sending') throw Error('DISPATCH_FENCED');
      command.state = result.state === 'retry' && command.attempts >= 5 ? 'review' : result.state;
      command.receipt = { ...result.receipt, state: command.state === 'retry' ? 'reserved' : command.state };
      command.nextAttemptAt = result.retryAt ?? 0; delete command.token; this.putCommand(command);
      // A dispatch token permits recording its result after lease/auth expiry,
      // but cannot authorize any new upstream write.
      this.sql.exec('UPDATE commands SET state = ?, receipt = ?, version = version + 1 WHERE command_key = ? AND operation_id = ? AND fence = ?', command.receipt.state, JSON.stringify(command.receipt), commandKey, command.operationId, command.fence);
    });
  }
  settleReconciliation(commandKey: string, expected: string, receipt: OperationReceipt): boolean {
    return this.storage.transactionSync(() => {
      const command = this.getExecutionCommand(commandKey);
      if (!command || canonical(command) !== expected || !['uncertain', 'sending', 'review'].includes(command.state)) return false;
      command.receipt = receipt; command.state = receipt.state === 'confirmed' ? 'confirmed' : 'review'; delete command.token; this.putCommand(command);
      this.sql.exec('UPDATE commands SET state = ?, receipt = ?, version = version + 1 WHERE command_key = ? AND operation_id = ?', receipt.state, JSON.stringify(receipt), commandKey, command.operationId);
      return true;
    });
  }
  setOperationStatus(operationId: string, status: OperationStatus): OperationStatus {
    status = operationStatusSchema.parse(status);
    if (status.operationId !== operationId) throw Error('OPERATION_MISMATCH');
    this.storage.transactionSync(() => {
      const operation = this.getOperation(operationId); if (!operation) throw Error('OPERATION_UNAVAILABLE');
      // Receipts are rebuilt from durable command state; a concurrent delivery
      // cannot overwrite confirmed state with its stale running observation.
      const commands = operation.input.authorization.plan.orderedCommands.map(c => this.getExecutionCommand(c.commandKey));
      status.receipts = commands.flatMap(c => c?.operationId === operationId ? [c.receipt] : []);
      if (commands.length && commands.every(c => c?.state === 'confirmed') && !status.pendingReasons.length) status.state = 'applied';
      operation.status = status; this.sql.exec('UPDATE execution_operations SET data = ? WHERE operation_id = ?', JSON.stringify(operation), operationId);
    });
    return status;
  }
}

export type ExecutionRepository = Pick<OperationsStore, 'prepareOperation' | 'getOperation' | 'getOperationByRequest' | 'reserveExecutionCommand' | 'getExecutionCommand' | 'beginDispatch' | 'finishDispatch' | 'settleReconciliation' | 'setOperationStatus'>;
export type AsyncRepository = { [K in keyof ExecutionRepository]: (...args: Parameters<ExecutionRepository[K]>) => Promise<Awaited<ReturnType<ExecutionRepository[K]>>> };
