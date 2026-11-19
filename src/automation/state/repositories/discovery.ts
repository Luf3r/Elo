import { SafeError } from '../../../shared/errors';
import { readJson } from '../../../shared/json';
import {
  discoveryCursorMs,
  discoveryCursorSchema,
  pendingActivitySchema,
  type DiscoveryCursor,
  type PendingActivity,
} from '../../discovery';
import type { AutomationPolicy } from '../../types';
import { EVIDENCE_RETENTION_MS } from './audit';

/** Persists pending activity discoveries, bounded discovery cursors and chat hint acknowledgements. */
export class DiscoveryRepository {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly getExecutionPolicy: () => AutomationPolicy | undefined,
  ) {}

  private get sql() {
    return this.storage.sql;
  }

  acknowledgeChatHints(conversationId: number): void {
    this.sql.exec('UPDATE chat_hints SET conversation_id = NULL WHERE conversation_id = ?', conversationId);
  }

  getPendingCursor(cursor: string): DiscoveryCursor | undefined {
    const row = this.sql
      .exec<{ data: string }>(
        'SELECT data FROM pending_cursors WHERE cursor = ? AND expires_at > ?',
        cursor,
        Date.now(),
      )
      .toArray()[0];
    return row ? readJson(discoveryCursorSchema, row.data, 'pending_cursors.data') : undefined;
  }

  getPendingActivity(id: string): (PendingActivity & { planId: string | null }) | undefined {
    const row = this.sql
      .exec<{ data: string; plan_id: string | null }>(
        'SELECT data, plan_id FROM pending_activity WHERE event_id = ? AND expires_at > ?',
        id,
        Date.now(),
      )
      .toArray()[0];
    return row
      ? { ...readJson(pendingActivitySchema, row.data, 'pending_activity.data'), planId: row.plan_id }
      : undefined;
  }

  savePendingPage(entries: PendingActivity[], policyVersion: number, next?: DiscoveryCursor) {
    return this.storage.transactionSync(() => {
      if (this.getExecutionPolicy()?.version !== policyVersion)
        throw new SafeError('POLICY_BLOCKED', 'Discovery policy changed; start a new scan.', false, 403);
      const now = Date.now();
      const pending = entries.filter((entry) => {
        const prior = this.getPendingActivity(entry.eventId);
        if (prior?.planId) return false;
        this.sql.exec(
          'INSERT INTO pending_activity VALUES (?, ?, ?, NULL) ON CONFLICT(event_id) DO UPDATE SET expires_at = excluded.expires_at, data = excluded.data',
          entry.eventId,
          now + EVIDENCE_RETENTION_MS,
          JSON.stringify(entry),
        );
        return true;
      });
      if (!next) return { entries: pending };
      this.sql.exec('DELETE FROM pending_cursors WHERE expires_at <= ?', now);
      // Bound storage even if clients repeatedly abandon cursors.
      if (this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM pending_cursors').one().count >= 1000)
        throw new SafeError(
          'UPSTREAM_RATE_LIMITED',
          'Discovery cursor capacity reached; retry after cursors expire.',
          true,
          429,
        );
      const cursor = crypto.randomUUID();
      this.sql.exec(
        'INSERT INTO pending_cursors VALUES (?, ?, ?)',
        cursor,
        next.startedAt + discoveryCursorMs,
        JSON.stringify(next),
      );
      return { entries: pending, cursor };
    });
  }
}
