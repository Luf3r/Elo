/** Numbered, atomic migrations. Never rewrite an applied migration. */
export function migrate(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    const sql = storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
    if (!sql.exec('SELECT version FROM schema_migrations WHERE version = 1').toArray().length) {
    sql.exec(`
      CREATE TABLE account_binding (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), crm_account_id TEXT NOT NULL, chat_account_id TEXT NOT NULL);
      CREATE TABLE customers (customer_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE bindings (binding_key TEXT PRIMARY KEY, customer_id TEXT NOT NULL, kind TEXT NOT NULL, external_id TEXT NOT NULL);
      CREATE UNIQUE INDEX unique_verified_binding ON bindings(kind, external_id) WHERE kind IN ('organization', 'person', 'chat_contact');
      CREATE TABLE identity_reservations (target_key TEXT PRIMARY KEY, work_id TEXT NOT NULL, fence INTEGER NOT NULL);
      CREATE TABLE events (event_id TEXT PRIMARY KEY, digest TEXT NOT NULL, data TEXT, evidence_expires_at INTEGER NOT NULL);
      CREATE TABLE work (work_id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, digest TEXT NOT NULL, target_key TEXT NOT NULL, lease TEXT NOT NULL, expires_at INTEGER NOT NULL, fence INTEGER NOT NULL);
      CREATE TABLE snapshot_manifest (work_id TEXT PRIMARY KEY, version INTEGER NOT NULL, digest TEXT NOT NULL, data TEXT, evidence_expires_at INTEGER NOT NULL);
      CREATE TABLE demands (demand_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT, evidence_expires_at INTEGER NOT NULL);
      CREATE TABLE facts (fact_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, version INTEGER NOT NULL, valid INTEGER NOT NULL DEFAULT 1, data TEXT, evidence_expires_at INTEGER NOT NULL);
      CREATE TABLE contexts (customer_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, version INTEGER NOT NULL, valid INTEGER NOT NULL DEFAULT 1, data TEXT, evidence_expires_at INTEGER NOT NULL);
      CREATE TABLE plans (plan_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, version INTEGER NOT NULL, digest TEXT NOT NULL, valid INTEGER NOT NULL DEFAULT 1, data TEXT, evidence_expires_at INTEGER NOT NULL);
      CREATE TABLE commands (command_key TEXT PRIMARY KEY, operation_id TEXT NOT NULL, work_id TEXT NOT NULL, digest TEXT NOT NULL, fence INTEGER NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL, receipt TEXT NOT NULL);
      CREATE TABLE reviews (review_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT, evidence_expires_at INTEGER NOT NULL);
      CREATE TABLE outbox (outbox_id TEXT PRIMARY KEY, command_key TEXT UNIQUE NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE policy (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE budget (reservation_id TEXT PRIMARY KEY, product TEXT NOT NULL CHECK(product IN ('crm', 'chat')), reserved_at INTEGER NOT NULL);
      CREATE INDEX budget_window ON budget(product, reserved_at);
      CREATE TABLE budget_clock (product TEXT PRIMARY KEY, last_now INTEGER NOT NULL);
      INSERT INTO schema_migrations VALUES (1);
    `);
    }
    if (!sql.exec('SELECT version FROM schema_migrations WHERE version = 2').toArray().length) {
      sql.exec(`
        ALTER TABLE plans ADD COLUMN fence INTEGER;
        ALTER TABLE plans ADD COLUMN snapshot_version INTEGER;
        ALTER TABLE plans ADD COLUMN context_version INTEGER;
        ALTER TABLE plans ADD COLUMN catalog_version TEXT;
        UPDATE plans SET valid = 0;
        INSERT INTO schema_migrations VALUES (2);
      `);
    }
    if (!sql.exec('SELECT version FROM schema_migrations WHERE version = 3').toArray().length) {
      sql.exec(`
        CREATE TABLE work_customers (work_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL);
        CREATE INDEX work_customers_by_customer ON work_customers(customer_id);
        INSERT INTO work_customers SELECT work_id, MIN(customer_id) FROM contexts GROUP BY work_id HAVING COUNT(DISTINCT customer_id) = 1;
        UPDATE plans SET valid = 0;
        UPDATE facts SET valid = 0 WHERE fact_id LIKE 'customer-context:%';
        INSERT INTO schema_migrations VALUES (3);
      `);
    }
  });
}
