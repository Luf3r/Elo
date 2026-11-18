import type { AccountRepository } from './state/repository';
import type { AutomationQueuePayload } from './queue';
import type { ExecutionOperation } from './operations';
export const WATCHDOG_INTERVAL_MS = 300_000;
export interface MaintenanceReport {
  expiredEvidence: number;
  deliveries: number;
  failedDeliveries: number;
  expiredReservations: number;
}
/** Maintenance only expires evidence and republishes references. It never
 * interprets messages, starts an agent or grants a fresh CRM authorization. */
export async function maintainAccount(
  now: number,
  deps: { repository: AccountRepository; queue: { send(body: AutomationQueuePayload): Promise<unknown> } },
): Promise<MaintenanceReport> {
  if (!Number.isSafeInteger(now) || now < 0) throw Error('INVALID_MAINTENANCE_TIME');
  const state = deps.repository.prepareMaintenance(now);
  const report: MaintenanceReport = {
    expiredEvidence: state.expiredEvidence,
    expiredReservations: state.expiredReservations,
    deliveries: 0,
    failedDeliveries: 0,
  };
  for (const operation of state.due) {
    try {
      await deps.queue.send(operationReference(operation));
      deps.repository.recordDelivery(operation.operationId, now, true);
      report.deliveries++;
    } catch {
      deps.repository.recordDelivery(operation.operationId, now, false);
      report.failedDeliveries++;
    }
  }
  return report;
}
function operationReference(operation: ExecutionOperation): AutomationQueuePayload {
  return { accountKey: 'elotenant', operationId: operation.operationId, version: operation.version };
}
