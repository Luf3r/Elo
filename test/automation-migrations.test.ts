import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { migrate, migrations, runMigrations, type Migration } from '../src/automation/state/migrations';
import type { WorkLease } from '../src/automation/types';
import type { Env } from '../src/env';

type SchemaRow = {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
};

const newStub = () => (env as Env).AUTOMATION_STATE.get((env as Env).AUTOMATION_STATE.newUniqueId());

function resetStorage(sql: SqlStorage) {
  const tables = sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    )
    .toArray();
  for (const { name } of tables) {
    sql.exec(`DROP TABLE IF EXISTS "${name}"`);
  }
}

function readSchema(sql: SqlStorage): SchemaRow[] {
  return sql
    .exec<SchemaRow>(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name",
    )
    .toArray();
}

function readAppliedVersions(sql: SqlStorage): number[] {
  return sql
    .exec<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')
    .toArray()
    .map((row) => row.version);
}

function makeLease(workId: string, target: WorkLease['target']): WorkLease {
  return {
    workId,
    leaseToken: `token-${workId}`,
    owner: { userId: 'operator-1', clientId: 'client-1' },
    fence: 1,
    expiresAt: '2030-01-01T00:00:00.000Z',
    mode: 'preview',
    target,
  };
}

function seedFixtureData(sql: SqlStorage, version: number, futureExpiry: number) {
  sql.exec('INSERT INTO account_binding VALUES (1, ?, ?)', 'crm-acc-1', 'chat-acc-1');
  sql.exec('INSERT INTO customers VALUES (?, ?)', 'cust-1', 2);
  sql.exec('INSERT INTO bindings VALUES (?, ?, ?, ?)', 'confirmed-crm:organization:11', 'cust-1', 'organization', '11');
  sql.exec('INSERT INTO identity_reservations VALUES (?, ?, ?)', 'target-ctx', 'work-ctx', 1);
  sql.exec('INSERT INTO events VALUES (?, ?, ?, ?)', 'evt-1', 'digest-1', '{"hello":"world"}', futureExpiry);
  sql.exec(
    'INSERT INTO work VALUES (?, ?, ?, ?, ?, ?, ?)',
    'work-ctx',
    'req-ctx',
    'digest-ctx',
    'target-ctx',
    JSON.stringify(makeLease('work-ctx', { kind: 'conversation', conversationId: 101 })),
    futureExpiry,
    1,
  );
  sql.exec(
    'INSERT INTO work VALUES (?, ?, ?, ?, ?, ?, ?)',
    'work-lease-cust',
    'req-lease-cust',
    'digest-lease-cust',
    'target-lease-cust',
    JSON.stringify(makeLease('work-lease-cust', { kind: 'customer', customerId: 'cust-lease' })),
    futureExpiry,
    1,
  );
  sql.exec(
    'INSERT INTO work VALUES (?, ?, ?, ?, ?, ?, ?)',
    'work-lease-conv',
    'req-lease-conv',
    'digest-lease-conv',
    'target-lease-conv',
    JSON.stringify(makeLease('work-lease-conv', { kind: 'conversation', conversationId: 202 })),
    futureExpiry,
    1,
  );
  sql.exec(
    'INSERT INTO work VALUES (?, ?, ?, ?, ?, ?, ?)',
    'work-lease-bad',
    'req-lease-bad',
    'digest-lease-bad',
    'target-lease-bad',
    '{not-valid-json',
    futureExpiry,
    1,
  );
  sql.exec(
    'INSERT INTO snapshot_manifest VALUES (?, ?, ?, ?, ?)',
    'work-ctx',
    1,
    'snap-digest',
    '{"workId":"work-ctx"}',
    futureExpiry,
  );
  sql.exec(
    'INSERT INTO demands VALUES (?, ?, ?, ?, ?)',
    'demand-1',
    'cust-1',
    1,
    '{"demandId":"demand-1"}',
    futureExpiry,
  );
  sql.exec(
    'INSERT INTO facts VALUES (?, ?, ?, ?, ?, ?)',
    'customer-context:cust-1',
    'work-ctx',
    1,
    1,
    '{"projection":{}}',
    futureExpiry,
  );
  sql.exec('INSERT INTO facts VALUES (?, ?, ?, ?, ?, ?)', 'fact-keep', 'work-ctx', 1, 1, '{"kept":true}', futureExpiry);
  sql.exec(
    'INSERT INTO contexts VALUES (?, ?, ?, ?, ?, ?)',
    'cust-1',
    'work-ctx',
    1,
    1,
    '{"customerId":"cust-1"}',
    futureExpiry,
  );
  if (version === 1) {
    sql.exec(
      'INSERT INTO plans VALUES (?, ?, ?, ?, ?, ?, ?)',
      'plan-1',
      'work-ctx',
      1,
      'plan-digest',
      1,
      '{"planId":"plan-1"}',
      futureExpiry,
    );
  } else {
    sql.exec(
      'INSERT INTO plans (plan_id, work_id, version, digest, valid, data, evidence_expires_at, fence, snapshot_version, context_version, catalog_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      'plan-1',
      'work-ctx',
      1,
      'plan-digest',
      1,
      '{"planId":"plan-1"}',
      futureExpiry,
      1,
      1,
      0,
      'cat-1',
    );
  }
  sql.exec(
    'INSERT INTO commands VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    'cmd-1',
    'op-1',
    'work-ctx',
    'cmd-digest',
    1,
    1,
    'confirmed',
    '{"state":"confirmed"}',
  );
  sql.exec('INSERT INTO reviews VALUES (?, ?, ?, ?, ?)', 'rev-1', 'work-ctx', 1, '{"reviewId":"rev-1"}', futureExpiry);
  sql.exec('INSERT INTO outbox VALUES (?, ?, ?, ?)', 'out-1', 'cmd-1', 'sent', 1);
  sql.exec('INSERT INTO policy VALUES (1, ?, ?)', 2, '{"version":2}');
  sql.exec('INSERT INTO budget VALUES (?, ?, ?)', 'res-1', 'crm', 12345);
  sql.exec('INSERT INTO budget_clock VALUES (?, ?)', 'crm', 12345);

  if (version >= 3) {
    sql.exec('INSERT INTO work_customers VALUES (?, ?)', 'work-ctx', 'cust-1');
  }
  if (version >= 4) {
    sql.exec('INSERT INTO work_customers VALUES (?, ?)', 'work-lease-cust', 'cust-lease');
  }
  if (version >= 5) {
    sql.exec(
      'INSERT INTO execution_operations VALUES (?, ?, ?, ?)',
      'op-1',
      'req-1',
      'op-digest',
      '{"operationId":"op-1"}',
    );
    sql.exec('INSERT INTO execution_commands VALUES (?, ?, ?, ?)', 'cmd-1', 'op-1', 9999, '{"operationId":"op-1"}');
  }
  if (version >= 6) {
    sql.exec('INSERT INTO operation_delivery VALUES (?, ?, ?)', 'op-1', 9999, 2);
    sql.exec('INSERT INTO execution_tombstones VALUES (?, ?, ?)', 'op-old', 'req-old', 'old-digest');
    sql.exec(
      'INSERT INTO operational_audit VALUES (?, ?, ?, ?, ?, ?, ?)',
      'audit-1',
      1000,
      'operator-1',
      'client-1',
      'work_created',
      'work-ctx',
      1,
    );
    sql.exec('INSERT INTO chat_hints VALUES (?, ?, ?, ?)', 'hint-1', 101, 1000, 'hint-digest');
  }
  if (version >= 7) {
    sql.exec('INSERT INTO pending_cursors VALUES (?, ?, ?)', 'cur-1', futureExpiry, '{"page":1}');
    sql.exec(
      'INSERT INTO pending_activity VALUES (?, ?, ?, ?)',
      'pending:1',
      futureExpiry,
      '{"eventId":"pending:1"}',
      null,
    );
  }
}

describe('durable object schema migrations', () => {
  const expectedVersions = migrations.map((m) => m.version);
  const previousVersions = migrations.slice(0, -1).map((m) => m.version);

  it('declares contiguous 1..N versions and migrates an empty database idempotently', async () => {
    expect(expectedVersions).toEqual(Array.from({ length: migrations.length }, (_, i) => i + 1));

    await runInDurableObject(newStub(), (_instance, ctx) => {
      const sql = ctx.storage.sql;
      const constructorSchema = readSchema(sql);
      expect(readAppliedVersions(sql)).toEqual(expectedVersions);

      resetStorage(sql);
      expect(readSchema(sql)).toEqual([]);

      migrate(ctx.storage);
      const fromEmptySchema = readSchema(sql);
      expect(fromEmptySchema).toEqual(constructorSchema);
      expect(readAppliedVersions(sql)).toEqual(expectedVersions);

      migrate(ctx.storage);
      expect(readSchema(sql)).toEqual(fromEmptySchema);
      expect(readAppliedVersions(sql)).toEqual(expectedVersions);
    });
  });

  it.each(previousVersions)(
    'upgrades from version %i to current with identical schema and preserved fixture data',
    async (fromVersion) => {
      const futureExpiry = Date.now() + 86_400_000;

      await runInDurableObject(newStub(), (_instance, ctx) => {
        const sql = ctx.storage.sql;
        const targetSchema = readSchema(sql);

        resetStorage(sql);
        migrate(ctx.storage, fromVersion);
        expect(readAppliedVersions(sql)).toEqual(Array.from({ length: fromVersion }, (_, i) => i + 1));

        seedFixtureData(sql, fromVersion, futureExpiry);
        migrate(ctx.storage);

        expect(readSchema(sql)).toEqual(targetSchema);
        expect(readAppliedVersions(sql)).toEqual(expectedVersions);

        expect(sql.exec('SELECT * FROM account_binding').toArray()).toEqual([
          { singleton: 1, crm_account_id: 'crm-acc-1', chat_account_id: 'chat-acc-1' },
        ]);
        expect(sql.exec('SELECT * FROM customers').toArray()).toEqual([{ customer_id: 'cust-1', version: 2 }]);
        expect(sql.exec('SELECT * FROM bindings').toArray()).toEqual([
          {
            binding_key: 'confirmed-crm:organization:11',
            customer_id: 'cust-1',
            kind: 'organization',
            external_id: '11',
          },
        ]);
        expect(sql.exec('SELECT * FROM identity_reservations').toArray()).toEqual([
          { target_key: 'target-ctx', work_id: 'work-ctx', fence: 1 },
        ]);
        expect(sql.exec('SELECT * FROM events').toArray()).toEqual([
          { event_id: 'evt-1', digest: 'digest-1', data: '{"hello":"world"}', evidence_expires_at: futureExpiry },
        ]);
        expect(sql.exec('SELECT work_id FROM work ORDER BY work_id').toArray()).toEqual([
          { work_id: 'work-ctx' },
          { work_id: 'work-lease-bad' },
          { work_id: 'work-lease-conv' },
          { work_id: 'work-lease-cust' },
        ]);
        expect(sql.exec('SELECT * FROM snapshot_manifest').toArray()).toEqual([
          {
            work_id: 'work-ctx',
            version: 1,
            digest: 'snap-digest',
            data: '{"workId":"work-ctx"}',
            evidence_expires_at: futureExpiry,
          },
        ]);
        expect(sql.exec('SELECT * FROM demands').toArray()).toEqual([
          {
            demand_id: 'demand-1',
            customer_id: 'cust-1',
            version: 1,
            data: '{"demandId":"demand-1"}',
            evidence_expires_at: futureExpiry,
          },
        ]);
        expect(sql.exec('SELECT fact_id, valid, data FROM facts ORDER BY fact_id').toArray()).toEqual([
          { fact_id: 'customer-context:cust-1', valid: fromVersion < 3 ? 0 : 1, data: '{"projection":{}}' },
          { fact_id: 'fact-keep', valid: 1, data: '{"kept":true}' },
        ]);
        expect(sql.exec('SELECT * FROM contexts').toArray()).toEqual([
          {
            customer_id: 'cust-1',
            work_id: 'work-ctx',
            version: 1,
            valid: 1,
            data: '{"customerId":"cust-1"}',
            evidence_expires_at: futureExpiry,
          },
        ]);
        expect(
          sql
            .exec('SELECT plan_id, valid, data, fence, snapshot_version, context_version, catalog_version FROM plans')
            .toArray(),
        ).toEqual([
          {
            plan_id: 'plan-1',
            valid: fromVersion < 3 ? 0 : 1,
            data: '{"planId":"plan-1"}',
            fence: fromVersion === 1 ? null : 1,
            snapshot_version: fromVersion === 1 ? null : 1,
            context_version: fromVersion === 1 ? null : 0,
            catalog_version: fromVersion === 1 ? null : 'cat-1',
          },
        ]);
        expect(sql.exec('SELECT * FROM commands').toArray()).toEqual([
          {
            command_key: 'cmd-1',
            operation_id: 'op-1',
            work_id: 'work-ctx',
            digest: 'cmd-digest',
            fence: 1,
            version: 1,
            state: 'confirmed',
            receipt: '{"state":"confirmed"}',
          },
        ]);
        expect(sql.exec('SELECT * FROM reviews').toArray()).toEqual([
          {
            review_id: 'rev-1',
            work_id: 'work-ctx',
            version: 1,
            data: '{"reviewId":"rev-1"}',
            evidence_expires_at: futureExpiry,
          },
        ]);
        expect(sql.exec('SELECT * FROM outbox').toArray()).toEqual([
          { outbox_id: 'out-1', command_key: 'cmd-1', state: 'sent', version: 1 },
        ]);
        expect(sql.exec('SELECT * FROM policy').toArray()).toEqual([
          { singleton: 1, version: 2, data: '{"version":2}' },
        ]);
        expect(sql.exec('SELECT * FROM budget').toArray()).toEqual([
          { reservation_id: 'res-1', product: 'crm', reserved_at: 12345 },
        ]);
        expect(sql.exec('SELECT * FROM budget_clock').toArray()).toEqual([{ product: 'crm', last_now: 12345 }]);
        expect(sql.exec('SELECT work_id, customer_id FROM work_customers ORDER BY work_id').toArray()).toEqual([
          { work_id: 'work-ctx', customer_id: 'cust-1' },
          { work_id: 'work-lease-cust', customer_id: 'cust-lease' },
        ]);

        if (fromVersion >= 5) {
          expect(sql.exec('SELECT * FROM execution_operations').toArray()).toEqual([
            { operation_id: 'op-1', request_id: 'req-1', digest: 'op-digest', data: '{"operationId":"op-1"}' },
          ]);
          expect(sql.exec('SELECT * FROM execution_commands').toArray()).toEqual([
            { command_key: 'cmd-1', operation_id: 'op-1', next_attempt_at: 9999, data: '{"operationId":"op-1"}' },
          ]);
        }
        if (fromVersion >= 6) {
          expect(sql.exec('SELECT * FROM operation_delivery').toArray()).toEqual([
            { operation_id: 'op-1', next_attempt_at: 9999, failures: 2 },
          ]);
          expect(sql.exec('SELECT * FROM execution_tombstones').toArray()).toEqual([
            { operation_id: 'op-old', request_id: 'req-old', digest: 'old-digest' },
          ]);
          expect(sql.exec('SELECT * FROM operational_audit').toArray()).toEqual([
            {
              audit_id: 'audit-1',
              occurred_at: 1000,
              user_id: 'operator-1',
              client_id: 'client-1',
              action: 'work_created',
              target_id: 'work-ctx',
              version: 1,
            },
          ]);
          expect(sql.exec('SELECT * FROM chat_hints').toArray()).toEqual([
            { hint_key: 'hint-1', conversation_id: 101, received_at: 1000, digest: 'hint-digest' },
          ]);
        }
        if (fromVersion >= 7) {
          expect(sql.exec('SELECT * FROM pending_cursors').toArray()).toEqual([
            { cursor: 'cur-1', expires_at: futureExpiry, data: '{"page":1}' },
          ]);
          expect(sql.exec('SELECT * FROM pending_activity').toArray()).toEqual([
            { event_id: 'pending:1', expires_at: futureExpiry, data: '{"eventId":"pending:1"}', plan_id: null },
          ]);
        }
      });
    },
  );

  it('applies pending migrations in ascending order and rolls back transactionally on error', async () => {
    await runInDurableObject(newStub(), (_instance, ctx) => {
      const sql = ctx.storage.sql;
      resetStorage(sql);

      const order: number[] = [];
      const outOfOrder: Migration[] = [
        {
          version: 2,
          up(db) {
            order.push(2);
            db.exec('INSERT INTO t VALUES (2)');
          },
        },
        {
          version: 1,
          up(db) {
            order.push(1);
            db.exec('CREATE TABLE t (v INTEGER)');
            db.exec('INSERT INTO t VALUES (1)');
          },
        },
      ];
      runMigrations(ctx.storage, outOfOrder);
      expect(order).toEqual([1, 2]);
      expect(readAppliedVersions(sql)).toEqual([1, 2]);
      expect(sql.exec('SELECT v FROM t ORDER BY v').toArray()).toEqual([{ v: 1 }, { v: 2 }]);

      const failing: Migration[] = [
        ...outOfOrder,
        {
          version: 3,
          up(db) {
            db.exec('INSERT INTO t VALUES (3)');
            throw new Error('BOOM');
          },
        },
      ];
      expect(() => runMigrations(ctx.storage, failing)).toThrow('BOOM');
      expect(readAppliedVersions(sql)).toEqual([1, 2]);
      expect(sql.exec('SELECT v FROM t ORDER BY v').toArray()).toEqual([{ v: 1 }, { v: 2 }]);
    });
  });
});
