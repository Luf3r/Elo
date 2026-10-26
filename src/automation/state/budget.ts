import type { Env } from '../../env';
import { SafeError } from '../../errors';
import type { BudgetTicket } from '../types';

export type BudgetGate = () => Promise<void>;
/** Account routing is server-owned; no request argument can select another bucket. */
export function accountState(env: Pick<Env, 'AUTOMATION_STATE'>) {
  if (!env.AUTOMATION_STATE) throw new SafeError('UPSTREAM_UNAVAILABLE', 'Shared request budget unavailable.', true, 503);
  return env.AUTOMATION_STATE.getByName('elotenant');
}
export function createBudgetGate(env: Partial<Pick<Env, 'AUTOMATION_STATE'>>, product: 'crm' | 'chat'): BudgetGate {
  return async () => {
    let ticket: BudgetTicket;
    try { ticket = await accountState(env as Pick<Env, 'AUTOMATION_STATE'>).takeBudget(product, Date.now()); }
    catch { throw new SafeError('UPSTREAM_UNAVAILABLE', 'Shared request budget unavailable.', true, 503); }
    if (!ticket.allowed) throw new SafeError('UPSTREAM_RATE_LIMITED', 'Shared request budget reached. Retry later.', true, 429);
  };
}
/** Reservation is irrevocable, including when transport cancellation follows it. */
export function takeBudget(storage: DurableObjectStorage, product: 'crm' | 'chat', now: number): BudgetTicket {
  if (!['crm', 'chat'].includes(product) || !Number.isSafeInteger(now) || now < 0) throw Error('INVALID_BUDGET_INPUT');
  return storage.transactionSync(() => {
    const sql = storage.sql;
    const previous = sql.exec<{ last_now: number }>('SELECT last_now FROM budget_clock WHERE product = ?', product).toArray()[0];
    now = Math.max(now, previous?.last_now ?? 0);
    sql.exec('INSERT INTO budget_clock VALUES (?, ?) ON CONFLICT(product) DO UPDATE SET last_now = excluded.last_now', product, now);
    sql.exec('DELETE FROM budget WHERE product = ? AND reserved_at <= ?', product, now - 10_000);
    const rows = sql.exec<{ reserved_at: number }>('SELECT reserved_at FROM budget WHERE product = ? ORDER BY reserved_at', product).toArray();
    if (rows.length >= 4) return { allowed: false, retryAt: rows[0]!.reserved_at + 10_000 };
    const reservationId = crypto.randomUUID();
    sql.exec('INSERT INTO budget VALUES (?, ?, ?)', reservationId, product, now);
    return { allowed: true, reservationId };
  });
}
