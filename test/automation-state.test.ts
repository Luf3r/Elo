import { authorizePlan } from '../src/automation/authorization';
import { env, runInDurableObject, evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AutomationAccount } from '../src/automation/state/account';
import type { Env } from '../src/env';
import type { CommandReservation, PlanBasis, WorkLease, SyncPlan, ReserveWorkInput, SnapshotManifest } from '../src/automation/types';
import { validCommand, validPlan } from './fixtures/automation';

const state = () => (env as Env).AUTOMATION_STATE.get((env as Env).AUTOMATION_STATE.newUniqueId());
const input = (requestId = 'request-1'): ReserveWorkInput => ({ requestId, target: { kind: 'conversation', conversationId: 101 }, mode: 'apply', actor: { userId: 'operator-1', clientId: 'client-1', scopes: ['automation:process'] }, payloadDigest: 'digest-1' });
const readAt = new Date().toISOString();
const manifest = (workId: string, snapshotVersion = 1): SnapshotManifest => ({ workId, snapshotVersion, contextVersion: 0, catalogVersion: 'catalog-1', readAt, sources: validCommand.sourceRefs, messages: [{ conversationId: 101, id: 201, revision: 'message-rev-1', hash: 'hash-1', direction: 'incoming' }], records: [], coverage: { complete: false, pagesRead: 1, missingReasons: ['history_unverified'] } });
const basis = (lease: WorkLease, snapshotVersion = 1, contextVersion = 0, catalogVersion = 'catalog-1'): PlanBasis => ({ lease, snapshotVersion, contextVersion, catalogVersion });
function authorization(lease: WorkLease, plan: SyncPlan = { ...validPlan, workId: lease.workId }) {
  return authorizePlan({ ...lease.owner, scopes: ['automation:process', 'crm:create'], expiresAt: Date.now() + 60_000 }, plan, { version: 1, mode: 'apply', allowedInboxIds: [], capabilities: ['crm:create'], funnelMapping: {}, stageMapping: [], customFieldMapping: [], nativeCreatorDisabled: true, limits: { maxConversations: 10, maxCommands: 10, maxRequests: 20 } });
}
async function installReady(stub: ReturnType<typeof state>, lease: WorkLease) {
  await stub.installSnapshot(lease, manifest(lease.workId));
  await stub.savePlan({ ...validPlan, workId: lease.workId }, basis(lease));
}
async function setup() {
  const stub = state(); const lease = await stub.reserveWork(input());
  await installReady(stub, lease);
  const reservation: CommandReservation = { operationId: 'operation-1', command: validCommand, ...basis(lease), authorization: authorization(lease), expectedVersion: 1, payloadDigest: 'command-digest' };
  return { stub, lease, reservation };
}
async function expire(stub: ReturnType<typeof state>) {
  await runInDurableObject(stub, (_instance, ctx) => { ctx.storage.sql.exec('UPDATE work SET expires_at = 0'); });
}

// Catch expected domain errors inside the instance: plugin 1.4.6 reports rejected
// RPC promises twice as unhandled, even when the caller awaits .rejects.
async function failure(stub: ReturnType<typeof state>, operation: (instance: AutomationAccount) => Promise<unknown>, message = '') {
  const result = await runInDurableObject(stub, async instance => {
    try { await operation(instance); return { failed: false, message: '' }; }
    catch (error) { return { failed: true, message: error instanceof Error ? error.message : String(error) }; }
  });
  expect(result.failed).toBe(true); expect(result.message).toContain(message);
}
describe('durable account coordination', () => {
  it('serializes simultaneous intent reservations and never grants a second command dispatch', async () => {
    const stub = state(); const [a, b] = await Promise.all([stub.reserveWork(input()), stub.reserveWork(input())]);
    expect(a).toEqual(b); expect(Date.parse(a.expiresAt) - Date.now()).toBeGreaterThan(590_000);
    await installReady(stub, a);
    const r = { operationId: 'operation-1', command: validCommand, ...basis(a), authorization: authorization(a), expectedVersion: 1, payloadDigest: 'digest' };
    const results = await Promise.all([stub.reserveCommand(r), stub.reserveCommand(r)]);
    expect(results.map(v => v.state).sort()).toEqual(['busy', 'reserved']);
    const keys = await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec('SELECT command_key FROM commands').toArray());
    expect(keys).toHaveLength(1);
  });
  it('rejects reused request/command IDs with changed payload even when caller reuses digest', async () => {
    const { stub, reservation } = await setup();
    await failure(stub, instance => instance.reserveWork({ ...input(), mode: 'preview' }), 'IDEMPOTENCY_CONFLICT');
    await failure(stub, instance => instance.reserveWork({ ...input(), actor: { ...input().actor, clientId: 'other' } }), 'IDEMPOTENCY_CONFLICT');
    await stub.reserveCommand(reservation);
    await failure(stub, instance => instance.reserveCommand({ ...reservation, command: { ...validCommand, kind: 'create_organization', payload: { name: 'Changed synthetic name' } } }), 'IDEMPOTENCY_CONFLICT');
  });
  it('rejects competing owners and fences expired leases before snapshot or completion writes', async () => {
    const { stub, lease, reservation } = await setup();
    await failure(stub, instance => instance.reserveWork(input('request-2')), 'WORK_BUSY');
    await stub.reserveCommand(reservation); await expire(stub);
    await failure(stub, instance => instance.installSnapshot(lease, manifest(lease.workId)), 'LEASE_EXPIRED');
    const next = await stub.reserveWork(input('request-2')); expect(next.fence).toBeGreaterThan(lease.fence);
    await failure(stub, instance => instance.completeCommand({ operationId: reservation.operationId, commandKey: validCommand.commandKey, fence: lease.fence, expectedVersion: 1, receipt: { operationId: reservation.operationId, commandKey: validCommand.commandKey, state: 'confirmed', updatedFields: [] } }), 'LEASE');
  });
  it('preserves uncertainty and idempotency over actual eviction and migration reapplication', async () => {
    const { stub, lease, reservation } = await setup(); await stub.reserveCommand(reservation);
    await stub.completeCommand({ operationId: reservation.operationId, commandKey: validCommand.commandKey, fence: lease.fence, expectedVersion: 1, receipt: { operationId: reservation.operationId, commandKey: validCommand.commandKey, state: 'uncertain', updatedFields: [] } });
    await evictDurableObject(stub);
    expect(await stub.reserveCommand(reservation)).toMatchObject({ state: 'uncertain', version: 2 });
    await evictDurableObject(stub);
    expect(await stub.reserveWork(input())).toEqual(lease);
    const migrations = await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec('SELECT version FROM schema_migrations').toArray());
    expect(migrations).toEqual([{ version: 1 }, { version: 2 }]);
  });
  it('treats abandoned in-flight commands as uncertain instead of retrying after lease expiry', async () => {
    const { stub, reservation } = await setup(); await stub.reserveCommand(reservation); await expire(stub);
    const lease = await stub.reserveWork(input('request-2'));
    expect(await stub.reserveCommand({ ...reservation, lease })).toMatchObject({ state: 'uncertain' });
  });
  it('compares verified account IDs on activation and never reuses state for changed credentials', async () => {
    const stub = state();
    await stub.activate({ crmAccountId: 'crm-synthetic', chatAccountId: 'chat-synthetic' });
    await evictDurableObject(stub);
    await stub.activate({ crmAccountId: 'crm-synthetic', chatAccountId: 'chat-synthetic' });
    await failure(stub, instance => instance.activate({ crmAccountId: 'crm-other', chatAccountId: 'chat-synthetic' }), 'ACCOUNT_RECONFIGURATION_REQUIRED');
  });
  it('persists reference-only manifests, rejects stale versions and invalidates plans on source changes', async () => {
    const { stub, lease } = await setup(); await stub.installSnapshot(lease, manifest(lease.workId));
    await stub.savePlan({ ...validPlan, workId: lease.workId }, basis(lease));
    await failure(stub, instance => instance.installSnapshot(lease, { ...manifest(lease.workId), catalogVersion: 'changed' }), 'VERSION_CONFLICT');
    const next = manifest(lease.workId, 2); next.messages[0]!.hash = 'changed';
    await stub.installSnapshot(lease, next);
    const plans = await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec('SELECT valid FROM plans').toArray());
    expect(plans).toEqual([{ valid: 0 }]);
    await failure(stub, instance => instance.installSnapshot(lease, { ...next, rawTranscript: 'SECRET' } as SnapshotManifest), );
    const contents = await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec('SELECT data FROM snapshot_manifest').toArray());
    expect(JSON.stringify(contents)).not.toContain('SECRET');
  });
  it('uses completion CAS and keeps confirmed command tombstones beyond evidence retention', async () => {
    const { stub, lease, reservation } = await setup(); await stub.reserveCommand(reservation);
    const completion = { operationId: reservation.operationId, commandKey: validCommand.commandKey, fence: lease.fence, expectedVersion: 1, receipt: { operationId: reservation.operationId, commandKey: validCommand.commandKey, state: 'confirmed' as const, crmRef: { kind: 'organization' as const, id: 99 }, updatedFields: [] } };
    await stub.completeCommand(completion);
    await failure(stub, instance => instance.completeCommand({ ...completion, receipt: { ...completion.receipt, crmRef: { kind: 'organization', id: 100 } } }), 'VERSION_CONFLICT');
    await stub.installSnapshot(lease, manifest(lease.workId)); await stub.savePlan({ ...validPlan, workId: lease.workId }, basis(lease));
    await runInDurableObject(stub, (instance, ctx) => { ctx.storage.sql.exec('UPDATE plans SET evidence_expires_at = 0'); ctx.storage.sql.exec('UPDATE snapshot_manifest SET evidence_expires_at = 0'); return instance.alarm(); });
    expect(await stub.reserveCommand(reservation)).toMatchObject({ state: 'already_confirmed', receipt: { crmRef: { id: 99 } } });
    const old = await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec('SELECT data FROM plans').toArray());
    expect(old).toEqual([{ data: null }]);
  });
});



it('requires a new snapshot after lease renewal and rejects expired actor authorization in milliseconds', async () => {
  const { stub, lease } = await setup(); await stub.installSnapshot(lease, manifest(lease.workId)); await expire(stub);
  const renewed = await stub.reserveWork(input()); expect(renewed.fence).toBeGreaterThan(lease.fence);
  await failure(stub, instance => instance.savePlan({ ...validPlan, workId: lease.workId }, basis(renewed)), 'SNAPSHOT_REQUIRED');
  await failure(state(), instance => instance.reserveWork({ ...input(), actor: { ...input().actor, expiresAt: Date.now() - 1 } }), 'AUTHORIZATION_EXPIRED');
});
it('serves current context only and prunes exactly at its evidence deadline without deleting durable links', async () => {
  const { stub, lease } = await setup();
  const context = { customerId: 'customer-1', version: 1, verifiedAt: new Date().toISOString(), markdown: 'Synthetic bounded context', evidenceRefs: validCommand.sourceRefs };
  const deadline = Date.now() + 10_000;
  await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec('INSERT INTO contexts VALUES (?, ?, 1, 1, ?, ?)', context.customerId, lease.workId, JSON.stringify(context), deadline).toArray());
  expect(await stub.getContext('customer-1')).toEqual(context);
  await runInDurableObject(stub, instance => instance.alarm());
  const alarm = await runInDurableObject(stub, (_instance, ctx) => ctx.storage.getAlarm());
  expect(alarm).toBe(deadline);
  await runInDurableObject(stub, (_instance, ctx) => { ctx.storage.sql.exec('UPDATE contexts SET evidence_expires_at = 0'); });
  await failure(stub, instance => instance.getContext('customer-1'), 'CONTEXT_UNAVAILABLE');
  await runInDurableObject(stub, instance => instance.alarm());
  const rows = await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec('SELECT data FROM contexts').toArray());
  expect(rows).toEqual([{ data: null }]);
});
it('allows shared phone observations without making phone a unique person identity', async () => {
  const stub = state(); await stub.reserveWork(input());
  const bindings = await runInDurableObject(stub, (_instance, ctx) => {
    ctx.storage.sql.exec("INSERT INTO bindings VALUES ('binding-1', 'customer-1', 'phone', 'synthetic-shared-phone'), ('binding-2', 'customer-2', 'phone', 'synthetic-shared-phone')");
    return ctx.storage.sql.exec('SELECT customer_id FROM bindings').toArray();
  });
  expect(bindings).toHaveLength(2);
});


it('keeps plan identity bound to its original work and checks all evidence references', async () => {
  const { stub, lease } = await setup(); await stub.installSnapshot(lease, manifest(lease.workId)); await stub.savePlan({ ...validPlan, workId: lease.workId }, basis(lease));
  const other = await stub.reserveWork({ ...input('other-request'), target: { kind: 'conversation', conversationId: 102 } });
  await stub.installSnapshot(other, manifest(other.workId));
  await failure(stub, instance => instance.savePlan({ ...validPlan, version: 2, workId: other.workId }, basis(other)), 'IDEMPOTENCY_CONFLICT');
  await failure(stub, instance => instance.savePlan({ ...validPlan, planId: 'other-plan', workId: lease.workId, after: [{ entity: 'organization', field: 'name', value: 'Synthetic', certainty: 'confirmed', sources: [{ kind: 'message', id: 'absent', revision: 'absent' }] }] }, basis(lease)), 'STALE_SOURCE');
});
it('preserves the request budget across eviction and rejects unsafe time input', async () => {
  const stub = state(); for (let i = 0; i < 4; i++) await stub.takeBudget('crm', 0);
  await evictDurableObject(stub);
  expect(await stub.takeBudget('crm', 1_000)).toEqual({ allowed: false, retryAt: 10_000 });
  await failure(stub, instance => instance.takeBudget('crm', NaN), 'INVALID_BUDGET_INPUT');
});

it('review R1 rejects a stale computation after renewal installs a newer manifest with unchanged source refs', async () => {
  const { stub, lease } = await setup();
  await stub.installSnapshot(lease, manifest(lease.workId));
  const oldPlan = { ...validPlan, workId: lease.workId };
  await expire(stub);
  const renewed = await stub.reserveWork(input());
  expect(renewed.workId).toBe(lease.workId);
  await stub.installSnapshot(renewed, { ...manifest(renewed.workId, 2), contextVersion: 1, catalogVersion: 'catalog-2' });
  await failure(stub, instance => instance.savePlan(oldPlan, basis(lease)), 'LEASE_FENCED');
});
it('review R2 rejects old commands atomically after a newer snapshot invalidates their authorized plan', async () => {
  const { stub, lease, reservation } = await setup();
  await stub.installSnapshot(lease, manifest(lease.workId));
  await stub.savePlan({ ...validPlan, workId: lease.workId }, basis(lease));
  await stub.installSnapshot(lease, { ...manifest(lease.workId, 2), contextVersion: 1, catalogVersion: 'catalog-2' });
  await failure(stub, instance => instance.reserveCommand(reservation), 'PLAN_STALE');
  const commands = await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec('SELECT command_key FROM commands').toArray());
  expect(commands).toEqual([]);
});


it.each([
  [1, 1, 'catalog-2'], [2, 0, 'catalog-2'], [2, 1, 'catalog-1'],
] as const)('rejects a plan computed from mismatched snapshot/context/catalog versions (%s, %s, %s)', async (snapshotVersion, contextVersion, catalogVersion) => {
  const { stub, lease } = await setup();
  await stub.installSnapshot(lease, { ...manifest(lease.workId, 2), contextVersion: 1, catalogVersion: 'catalog-2' });
  await failure(stub, instance => instance.savePlan({ ...validPlan, version: 2, workId: lease.workId }, basis(lease, snapshotVersion, contextVersion, catalogVersion)), 'STATE_VERSION_CONFLICT');
  await stub.savePlan({ ...validPlan, version: 2, workId: lease.workId }, basis(lease, 2, 1, 'catalog-2'));
});
it('requires current authorized plan version, exact command membership, matching actor and original authorization expiry', async () => {
  const { stub, lease, reservation } = await setup();
  await failure(stub, instance => instance.reserveCommand({ ...reservation, command: { ...validCommand, commandKey: 'not-in-plan' } }), 'COMMAND_NOT_AUTHORIZED');
  await failure(stub, instance => instance.reserveCommand({ ...reservation, authorization: { ...reservation.authorization, actor: { ...reservation.authorization.actor, userId: 'other-user' } } }), 'COMMAND_NOT_AUTHORIZED');
  await failure(stub, instance => instance.reserveCommand({ ...reservation, authorization: { ...reservation.authorization, validUntil: new Date(Date.now() - 1).toISOString() } }), 'AUTHORIZATION_EXPIRED');
  await stub.savePlan({ ...validPlan, workId: lease.workId, version: 2 }, basis(lease));
  await failure(stub, instance => instance.reserveCommand(reservation), 'PLAN_STALE');
  expect(await stub.reserveCommand({ ...reservation, authorization: authorization(lease, { ...validPlan, workId: lease.workId, version: 2 }) })).toMatchObject({ state: 'reserved' });
});
it('migrates existing v1 plans as invalid and preserves command tombstones through upgrade and restart', async () => {
  const { stub, reservation } = await setup(); await stub.reserveCommand(reservation);
  await runInDurableObject(stub, (_instance, ctx) => {
    ctx.storage.sql.exec('ALTER TABLE plans DROP COLUMN fence; ALTER TABLE plans DROP COLUMN snapshot_version; ALTER TABLE plans DROP COLUMN context_version; ALTER TABLE plans DROP COLUMN catalog_version; DELETE FROM schema_migrations WHERE version = 2');
  });
  await evictDurableObject(stub);
  expect(await stub.reserveCommand(reservation)).toMatchObject({ state: 'busy' });
  const row = await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec('SELECT valid, fence FROM plans').one());
  expect(row).toEqual({ valid: 0, fence: null });
  await evictDurableObject(stub);
  const versions = await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec('SELECT version FROM schema_migrations').toArray());
  expect(versions).toEqual([{ version: 1 }, { version: 2 }]);
});
