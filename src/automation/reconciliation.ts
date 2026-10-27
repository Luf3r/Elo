import type { AgendorCrmClient, CrmMutationRef } from '../agendor/crm/types';
import type { MutationCommand, OperationReceipt, ReconciliationResult } from './types';
import type { AsyncRepository, ExecutionCommand } from './operations';
import { canonical } from './operations';

export type ReconciliationReads = Pick<AgendorCrmClient, 'getOrganization' | 'getPerson' | 'getDeal' | 'getTask'> & Partial<Pick<AgendorCrmClient, 'searchOrganizations' | 'searchPeople' | 'searchDeals' | 'listTasks'>>;
export interface ReconciliationDeps { repository: AsyncRepository; reads: ReconciliationReads }
export async function resolvedTarget(command: MutationCommand, operationId: string, repository: AsyncRepository): Promise<CrmMutationRef | undefined> {
  if (!('target' in command) || !command.target) return;
  if ('id' in command.target) return command.target;
  const parent = await repository.getExecutionCommand(command.target.commandKey);
  if (!command.dependencies.includes(command.target.commandKey) || parent?.operationId !== operationId || parent.state !== 'confirmed' || parent.receipt.crmRef?.kind !== command.target.kind) throw Error('DEPENDENCY_NOT_CONFIRMED');
  return parent.receipt.crmRef;
}
export async function desiredFields(command: MutationCommand, operationId: string, repository: AsyncRepository): Promise<Record<string, unknown>> {
  const record: Record<string, unknown> = { ...('payload' in command ? command.payload : command.patch) };
  if (command.kind === 'create_person' && command.target) record.organization = (await resolvedTarget(command, operationId, repository))?.id;
  return record;
}
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
/** Compare requested fields only. Unknown/missing fields are never confirmation. */
export function matchesFields(record: unknown, desired: Record<string, unknown>): boolean {
  const actual = object(record); if (!actual) return false;
  return Object.entries(desired).filter(([key]) => key !== 'checkRequiredFields').every(([key, expected]) => {
    const value = actual[key];
    if (object(expected)) return matchesFields(value, expected as Record<string, unknown>);
    if (typeof expected === 'number' && object(value)?.id === expected) return true;
    return canonical(value) === canonical(expected);
  });
}
export async function readRef(ref: CrmMutationRef, reads: ReconciliationReads): Promise<unknown> {
  switch (ref.kind) {
    case 'organization': return reads.getOrganization(ref.id);
    case 'person': return reads.getPerson(ref.id);
    case 'deal': return reads.getDeal(ref.id);
    case 'task': return reads.getTask(ref.id);
  }
}
export async function checkedReceipt(ledger: ExecutionCommand, ref: CrmMutationRef, deps: ReconciliationDeps): Promise<OperationReceipt | undefined> {
  const expectedKind = ledger.command.kind === 'change_stage' ? 'deal' : ledger.command.kind === 'update_task' ? 'task' : ledger.command.kind.split('_')[1];
  if (ref.kind !== expectedKind) return;
  const record = await readRef(ref, deps.reads); const data = object(record);
  const desired = await desiredFields(ledger.command, ledger.operationId, deps.repository);
  if (data?.id !== ref.id || !matchesFields(record, desired)) return;
  return { operationId: ledger.operationId, commandKey: ledger.command.commandKey, state: 'confirmed', crmRef: ref, updatedFields: Object.keys(desired), checkedAt: new Date().toISOString() };
}

/** Reconciliation performs GETs only, even after operational authorization ends.
 * A name or title alone cannot attribute a record to an uncertain POST. */
export async function reconcileCommand(commandKey: string, deps: ReconciliationDeps): Promise<ReconciliationResult> {
  const ledger = await deps.repository.getExecutionCommand(commandKey);
  if (!ledger) return { state: 'review', reviewReasons: ['COMMAND_UNAVAILABLE'] };
  if (ledger.state === 'confirmed') return { state: 'confirmed', receipt: ledger.receipt };
  const expected = canonical(ledger);
  let receipt: OperationReceipt | undefined;
  try {
    let ref = ledger.receipt.crmRef;
    if (!ref && 'target' in ledger.command && !ledger.command.kind.startsWith('create_')) ref = await resolvedTarget(ledger.command, ledger.operationId, deps.repository);
    if (!ref) {
      const command = ledger.command; const desired = await desiredFields(command, ledger.operationId, deps.repository);
      const email = object(desired.contact)?.email;
      const strongCnpj = typeof desired.cnpj === 'string' && desired.cnpj.replace(/\D/g, '').length === 14;
      const strongEmail = typeof email === 'string';
      const query = command.kind === 'create_organization' && strongCnpj && deps.reads.searchOrganizations
        ? (page: number) => deps.reads.searchOrganizations!({ cnpj: desired.cnpj as string, page, perPage: 100 })
        : command.kind === 'create_person' && strongEmail && deps.reads.searchPeople
          ? (page: number) => deps.reads.searchPeople!({ email: email as string, page, perPage: 100 }) : undefined;
      const matches: CrmMutationRef[] = []; let complete = false;
      if (query) for (let page = 1; page <= 5; page++) {
        const result = await query(page);
        for (const item of result.items) {
          const record = object(item); const id = record?.id;
          if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && matchesFields(item, desired) && !matches.some(m => m.id === id)) matches.push({ kind: command.kind === 'create_organization' ? 'organization' : 'person', id });
        }
        if (!result.pageInfo.hasNext) { complete = true; break; }
        if (result.pageInfo.nextPage !== page + 1) break;
      }
      if (complete && matches.length === 1) ref = matches[0];
    }
    if (ref) receipt = await checkedReceipt(ledger, ref, deps);
  } catch { return { state: 'uncertain', reviewReasons: ['RECONCILIATION_READ_DEFERRED'] }; }
  if (receipt) {
    if (await deps.repository.settleReconciliation(commandKey, expected, receipt)) return { state: 'confirmed', receipt };
    return { state: 'uncertain', reviewReasons: ['RECONCILIATION_RACED'] };
  }
  await deps.repository.settleReconciliation(commandKey, expected, { ...ledger.receipt, state: 'review' });
  return { state: 'review', reviewReasons: ['UPSTREAM_EFFECT_NOT_UNIQUELY_PROVEN'] };
}
