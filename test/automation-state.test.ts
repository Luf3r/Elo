import { env, runInDurableObject, evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AutomationAccount } from '../src/automation/state/account';
import type { Env } from '../src/env';
import type { CommandReservation, ReserveWorkInput, SnapshotManifest } from '../src/automation/types';
import { validCommand, validPlan } from './fixtures/automation';

const state = () => (env as Env).AUTOMATION_STATE.get((env as Env).AUTOMATION_STATE.newUniqueId());
const input = (requestId = 'request-1'): ReserveWorkInput => ({ requestId, target: { kind: 'conversation', conversationId: 101 }, mode: 'apply', actor: { userId: 'operator-1', clientId: 'client-1', scopes: ['automation:process'] }, payloadDigest: 'digest-1' });
const manifest = (workId: string, snapshotVersion = 1): SnapshotManifest => ({ workId, snapshotVersion, contextVersion: 0, catalogVersion: 'catalog-1', readAt: new Date().toISOString(), sources: validCommand.sourceRefs, messages: [{ conversationId: 101, id: 201, revision: 'message-rev-1', hash: 'hash-1', direction: 'incoming' }], records: [], coverage: { complete: false, pagesRead: 1, missingReasons: ['history_unverified'] } });
async function setup() {
  const stub = state(); const lease = await stub.reserveWork(input());
  const reservation: CommandReservation = { operationId: 'operation-1', command: validCommand, lease, expectedVersion: 1, payloadDigest: 'command-digest' };
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
    const r = { operationId: 'operation-1', command: validCommand, lease: a, expectedVersion: 1, payloadDigest: 'digest' };
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
    expect(migrations).toEqual([{ version: 1 }]);
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
    await stub.savePlan({ ...validPlan, workId: lease.workId });
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
    await stub.installSnapshot(lease, manifest(lease.workId)); await stub.savePlan({ ...validPlan, workId: lease.workId });
    await runInDurableObject(stub, (instance, ctx) => { ctx.storage.sql.exec('UPDATE plans SET evidence_expires_at = 0'); ctx.storage.sql.exec('UPDATE snapshot_manifest SET evidence_expires_at = 0'); return instance.alarm(); });
    expect(await stub.reserveCommand(reservation)).toMatchObject({ state: 'already_confirmed', receipt: { crmRef: { id: 99 } } });
    const old = await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec('SELECT data FROM plans').toArray());
    expect(old).toEqual([{ data: null }]);
  });
});



it('requires a new snapshot after lease renewal and rejects expired actor authorization in milliseconds', async () => {
  const { stub, lease } = await setup(); await stub.installSnapshot(lease, manifest(lease.workId)); await expire(stub);
  const renewed = await stub.reserveWork(input()); expect(renewed.fence).toBeGreaterThan(lease.fence);
  await failure(stub, instance => instance.savePlan({ ...validPlan, workId: lease.workId }), 'SNAPSHOT_REQUIRED');
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
  const { stub, lease } = await setup(); await stub.installSnapshot(lease, manifest(lease.workId)); await stub.savePlan({ ...validPlan, workId: lease.workId });
  const other = await stub.reserveWork({ ...input('other-request'), target: { kind: 'conversation', conversationId: 102 } });
  await stub.installSnapshot(other, manifest(other.workId));
  await failure(stub, instance => instance.savePlan({ ...validPlan, version: 2, workId: other.workId }), 'IDEMPOTENCY_CONFLICT');
  await failure(stub, instance => instance.savePlan({ ...validPlan, planId: 'other-plan', workId: lease.workId, after: [{ entity: 'organization', field: 'name', value: 'Synthetic', certainty: 'confirmed', sources: [{ kind: 'message', id: 'absent', revision: 'absent' }] }] }), 'STALE_SOURCE');
});
it('preserves the request budget across eviction and rejects unsafe time input', async () => {
  const stub = state(); for (let i = 0; i < 4; i++) await stub.takeBudget('crm', 0);
  await evictDurableObject(stub);
  expect(await stub.takeBudget('crm', 1_000)).toEqual({ allowed: false, retryAt: 10_000 });
  await failure(stub, instance => instance.takeBudget('crm', NaN), 'INVALID_BUDGET_INPUT');
});
