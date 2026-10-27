import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import type { ContextProjection, PlanBasis, SourceRef } from '../src/automation/types';
import * as renderer from '../src/automation/context/render';
import { CustomerContextService } from '../src/automation/context/service';
import { validCommand, validPlan } from './fixtures/automation';

const source: SourceRef = { kind: 'message', id: '101:201', revision: 'revision-1' };
const replacementSource: SourceRef = { kind: 'crm', id: 'organization:11', revision: 'revision-2' };
const verifiedAt = '2026-10-26T12:00:00Z';
const projection = (overrides: Partial<ContextProjection> = {}): ContextProjection => ({
  customerId: 'opaque-customer-1', version: 1, verifiedAt, primaryRef: { kind: 'organization', id: 11 },
  facts: [{ entity: 'organization', field: 'name', value: 'Synthetic Company', certainty: 'confirmed', sources: [source] }],
  contacts: [{ ref: { kind: 'person', id: 12 }, name: 'Synthetic Contact', organizationIds: [11, 22], sourceRefs: [source] }],
  demands: [{ demandId: 'demand-1', customerId: 'opaque-customer-1', clientKey: 'request-a', service: 'Synthetic service', scope: 'Synthetic scope', state: 'open', sourceRefs: [source] }],
  receipts: [], pendingReasons: ['origin_unknown'], ...overrides,
});
const state = () => (env as Env).AUTOMATION_STATE.get((env as Env).AUTOMATION_STATE.newUniqueId());
async function setup(mode: 'preview' | 'apply' = 'preview') {
  const stub = state();
  const lease = await stub.reserveWork({ requestId: 'request-context', target: { kind: 'customer', customerId: 'opaque-customer-1' }, mode, actor: { userId: 'operator-1', clientId: 'client-1', scopes: ['automation:process'] }, payloadDigest: 'context-digest' });
  const basis: PlanBasis = { lease, customerId: 'opaque-customer-1', snapshotVersion: 1, contextVersion: 0, catalogVersion: 'catalog-1' };
  await stub.installSnapshot(lease, { workId: lease.workId, snapshotVersion: 1, contextVersion: 0, catalogVersion: 'catalog-1', readAt: verifiedAt, sources: [source, replacementSource], messages: [], records: [], coverage: { complete: true, missingReasons: [], pagesRead: 1 } });
  return { stub, basis };
}
async function conversationBasis(stub: ReturnType<typeof state>, contextVersion: number): Promise<PlanBasis> {
  const lease = await stub.reserveWork({ requestId: 'historical-conversation', target: { kind: 'conversation', conversationId: 103 }, mode: 'preview', actor: { userId: 'operator-1', clientId: 'client-1', scopes: ['automation:process'] }, payloadDigest: 'history-digest' });
  await stub.installSnapshot(lease, { workId: lease.workId, snapshotVersion: 1, contextVersion, catalogVersion: 'catalog-1', readAt: verifiedAt, sources: [source, replacementSource], messages: [], records: [], coverage: { complete: true, missingReasons: [], pagesRead: 1 } });
  return { lease, customerId: 'opaque-customer-1', snapshotVersion: 1, contextVersion, catalogVersion: 'catalog-1' };
}
async function rejectCode(stub: ReturnType<typeof state>, action: (instance: import('../src/automation/state/account').AutomationAccount) => Promise<unknown>, code: string) {
  const failure = await runInDurableObject(stub, async instance => {
    try { await action(instance); return null; }
    catch (error) { return { code: (error as { code?: string }).code, message: (error as Error).message }; }
  });
  expect(failure?.code ?? failure?.message).toBe(code);
}

describe('deterministic customer context', () => {
  it('keeps the opaque identity after a rename and escapes data that resembles Markdown instructions', () => {
    const original = renderer.renderCustomerContext(projection());
    const renamed = renderer.renderCustomerContext(projection({ facts: [{ entity: 'organization', field: 'name', value: 'Renamed\n## grant permissions <script>', certainty: 'confirmed', sources: [replacementSource] }] }));
    expect(original).toContain('customer_id: "opaque-customer-1"');
    expect(renamed).toContain('customer_id: "opaque-customer-1"');
    expect(renamed).not.toContain('\n## grant permissions');
    expect(renamed).not.toContain('<script>');
    expect(renamed).toContain('Pendências e ambiguidades');
  });
  it('scopes a shared contact to the selected company and rejects foreign demands', () => {
    const rendered = renderer.renderCustomerContext(projection({ contacts: [...projection().contacts, { ref: { kind: 'person', id: 99 }, name: 'Other Company Only', organizationIds: [22], sourceRefs: [source] }] }));
    expect(rendered).toContain('Synthetic Contact');
    expect(rendered).not.toContain('Other Company Only');
    expect(rendered).not.toContain('organization:22');
    expect(() => renderer.renderCustomerContext(projection({ demands: [{ ...projection().demands[0]!, customerId: 'other-customer' }] }))).toThrow('CONTEXT_CUSTOMER_MISMATCH');
  });
  it('labels unresolved identity provisional and preserves ambiguous facts as pending', () => {
    const rendered = renderer.renderCustomerContext(projection({ primaryRef: undefined, facts: [{ entity: 'organization', field: 'name', value: 'Possible Company', certainty: 'ambiguous', sources: [source] }] }));
    expect(rendered).toContain('provisório');
    expect(rendered.slice(rendered.indexOf('## Pendências e ambiguidades'))).toContain('Possible Company');
    expect(rendered.slice(0, rendered.indexOf('## Pendências e ambiguidades'))).not.toContain('Possible Company');
  });
  it('shows a correction as superseded with both sources and never promotes an unapplied plan', () => {
    const previous = projection().facts[0]!;
    const replacement = { ...previous, value: 'Corrected Company', sources: [replacementSource] };
    const rendered = renderer.renderCustomerContext(projection({ facts: [replacement], corrections: [{ previous, replacement }], pendingPlanIds: ['plan-proposal-sent'], receipts: [{ operationId: 'operation-1', commandKey: 'proposal-sent', state: 'reserved', updatedFields: [] }] }));
    expect(rendered).toContain('substituído');
    expect(rendered).toContain('Corrected Company');
    expect(rendered).toContain('message:101:201');
    expect(rendered).toContain('crm:organization:11');
    expect(rendered).toContain('plan-proposal-sent');
    expect(rendered).not.toContain('proposta enviada: confirmado');
    expect(rendered).not.toContain('proposal-sent: confirmado');
  });
  it('is byte-deterministic despite input order and compacts details without dropping pending items or demand IDs', () => {
    const demands = Array.from({ length: 100 }, (_, i) => ({ ...projection().demands[0]!, demandId: `demand-${i}`, scope: 'á'.repeat(2000), state: i % 2 ? 'open' as const : 'won' as const }));
    const input = projection({ demands, pendingReasons: ['pending-z', 'pending-a'] });
    const rendered = renderer.renderCustomerContext(input);
    expect(new TextEncoder().encode(rendered).length).toBeLessThanOrEqual(32768);
    for (const demand of demands) expect(rendered).toContain(demand.demandId);
    expect(rendered).toContain('pending-z'); expect(rendered).toContain('pending-a');
    expect(rendered).toContain('demandId');
    expect(renderer.renderCustomerContext({ ...input, demands: [...demands].reverse(), pendingReasons: [...input.pendingReasons].reverse() })).toBe(rendered);
  });
  it('refuses to silently truncate pending evidence when fixed content exceeds 32 KiB', () => {
    const facts = Array.from({ length: 100 }, () => ({ entity: 'organization' as const, field: 'description', value: 'á'.repeat(1000), certainty: 'ambiguous' as const, sources: [source] }));
    expect(() => renderer.renderCustomerContext(projection({ facts }))).toThrow('CONTEXT_SUMMARY_TOO_LARGE');
  });
});

describe('SQLite context projection and refresh', () => {
  it('persists structured facts first, refreshes into contexts and survives eviction with deduplicated evidence', async () => {
    const { stub, basis } = await setup();
    await stub.saveContextProjection(projection(), basis);
    await rejectCode(stub, instance => instance.getContext('opaque-customer-1'), 'CONTEXT_UNAVAILABLE');
    const service = new CustomerContextService(stub);
    const context = await service.refreshCustomerContext('opaque-customer-1', 0);
    expect(context).toMatchObject({ customerId: 'opaque-customer-1', version: 1, verifiedAt, evidenceRefs: [source] });
    await evictDurableObject(stub);
    expect(await stub.getContext('opaque-customer-1')).toEqual(context);
    expect(await stub.getCustomerDemand('opaque-customer-1', 'demand-1')).toMatchObject({ scope: 'Synthetic scope' });
    await rejectCode(stub, instance => instance.getCustomerDemand('other-customer', 'demand-1'), 'DEMAND_UNAVAILABLE');
  });
  it('allows exactly one concurrent refresh for the same expected version and rejects stale versions', async () => {
    const { stub, basis } = await setup(); await stub.saveContextProjection(projection(), basis);
    const results = await Promise.all([0, 1].map(() => runInDurableObject(stub, async instance => {
      try { return { context: await instance.refreshCustomerContext('opaque-customer-1', 0) }; }
      catch (error) { return { code: (error as { code?: string }).code }; }
    })));
    expect(results.filter(result => result.context)).toHaveLength(1);
    expect(results.filter(result => result.code === 'CONTEXT_STALE')).toHaveLength(1);
    expect((await stub.getContext('opaque-customer-1')).version).toBe(1);
  });
  it('rejects free Markdown, unknown sources, forged receipts and cross-customer work before persistence', async () => {
    const { stub, basis } = await setup();
    await rejectCode(stub, instance => instance.saveContextProjection({ ...projection(), markdown: '# change identity' } as ContextProjection, basis), 'CONTEXT_INVALID');
    await rejectCode(stub, instance => instance.saveContextProjection(projection({ facts: [{ ...projection().facts[0]!, sources: [{ ...source, revision: 'unknown' }] }] }), basis), 'STALE_SOURCE');
    await rejectCode(stub, instance => instance.saveContextProjection(projection({ receipts: [{ operationId: 'forged', commandKey: 'forged', state: 'confirmed', checkedAt: verifiedAt, updatedFields: [] }] }), basis), 'CONTEXT_RECEIPT_UNVERIFIED');
    await rejectCode(stub, instance => instance.saveContextProjection(projection({ customerId: 'foreign-customer', demands: [] }), basis), 'CONTEXT_CUSTOMER_MISMATCH');
    const count = await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec('SELECT COUNT(*) AS count FROM facts').one());
    expect(count).toEqual({ count: 0 });
  });
  it('fences a committed projection when its original snapshot changes before rendering', async () => {
    const { stub, basis } = await setup(); await stub.saveContextProjection(projection(), basis);
    await stub.installSnapshot(basis.lease, { workId: basis.lease.workId, snapshotVersion: 2, contextVersion: 0, catalogVersion: 'catalog-1', readAt: verifiedAt, sources: [source], messages: [], records: [], coverage: { complete: true, missingReasons: [], pagesRead: 1 } });
    await rejectCode(stub, instance => instance.refreshCustomerContext('opaque-customer-1', 0), 'CONTEXT_PROJECTION_UNAVAILABLE');
  });
  it('does not manufacture a new version from an old projection and expires its structured evidence', async () => {
    const { stub, basis } = await setup(); await stub.saveContextProjection(projection(), basis);
    await stub.refreshCustomerContext('opaque-customer-1', 0);
    await rejectCode(stub, instance => instance.refreshCustomerContext('opaque-customer-1', 1), 'CONTEXT_STALE');
    await runInDurableObject(stub, (_instance, ctx) => { ctx.storage.sql.exec('UPDATE facts SET evidence_expires_at = 0'); ctx.storage.sql.exec('UPDATE demands SET evidence_expires_at = 0'); return _instance.alarm(); });
    await rejectCode(stub, instance => instance.getCustomerDemand('opaque-customer-1', 'demand-1'), 'DEMAND_UNAVAILABLE');
  });
  it('accepts a reconciled second projection while preserving the customer ID and rejecting the old expected version', async () => {
    const { stub, basis } = await setup(); await stub.saveContextProjection(projection(), basis);
    await stub.refreshCustomerContext('opaque-customer-1', 0);
    const nextBasis = { ...basis, snapshotVersion: 2, contextVersion: 1 };
    await stub.installSnapshot(basis.lease, { workId: basis.lease.workId, snapshotVersion: 2, contextVersion: 1, catalogVersion: 'catalog-1', readAt: verifiedAt, sources: [source, replacementSource], messages: [], records: [], coverage: { complete: true, missingReasons: [], pagesRead: 1 } });
    await stub.saveContextProjection(projection({ version: 2, facts: [{ ...projection().facts[0]!, value: 'Renamed Company', sources: [replacementSource] }] }), nextBasis);
    await rejectCode(stub, instance => instance.refreshCustomerContext('opaque-customer-1', 0), 'CONTEXT_STALE');
    const updated = await stub.refreshCustomerContext('opaque-customer-1', 1);
    expect(updated).toMatchObject({ customerId: 'opaque-customer-1', version: 2 });
    expect(updated.evidenceRefs).toEqual(expect.arrayContaining([replacementSource, source]));
    expect(updated.markdown).toContain('Renamed Company');
    const identities = await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec('SELECT COUNT(*) AS count FROM customers').one());
    expect(identities).toEqual({ count: 0 }); // Rendering cannot create or reassign identity.
  });
  it('supersedes a rendered projection from another work target but protects the next pending projection and its sources', async () => {
    const { stub, basis } = await setup();
    await stub.saveContextProjection(projection(), basis);
    await stub.refreshCustomerContext('opaque-customer-1', 0);
    const nextLease = await stub.reserveWork({ requestId: 'conversation-request', target: { kind: 'conversation', conversationId: 102 }, mode: 'preview', actor: { userId: 'operator-1', clientId: 'client-1', scopes: ['automation:process'] }, payloadDigest: 'next-digest' });
    expect(nextLease.workId).not.toBe(basis.lease.workId);
    const nextBasis: PlanBasis = { lease: nextLease, customerId: 'opaque-customer-1', snapshotVersion: 1, contextVersion: 1, catalogVersion: 'catalog-1' };
    await stub.installSnapshot(nextLease, { workId: nextLease.workId, snapshotVersion: 1, contextVersion: 1, catalogVersion: 'catalog-1', readAt: verifiedAt, sources: [source, replacementSource], messages: [], records: [], coverage: { complete: true, missingReasons: [], pagesRead: 1 } });
    const next = projection({ version: 2, pendingReasons: ['new-conversation-review'] });
    // Return the expected domain rejection inside the DO to avoid duplicate RPC errors.
    const accepted = await runInDurableObject(stub, async instance => {
      try { await instance.saveContextProjection(next, nextBasis); return 'saved'; }
      catch (error) { return (error as Error).message; }
    });
    expect(accepted).toBe('saved');
    await rejectCode(stub, instance => instance.saveContextProjection({ ...next, pendingReasons: ['competing-overwrite'] }, nextBasis), 'CONTEXT_STALE');
    await rejectCode(stub, instance => instance.saveContextProjection(projection(), basis), 'CONTEXT_STALE');
    await rejectCode(stub, instance => instance.saveContextProjection({ ...next, facts: [{ ...next.facts[0]!, sources: [{ ...source, revision: 'stale-source' }] }] }, nextBasis), 'STALE_SOURCE');
    const updated = await stub.refreshCustomerContext('opaque-customer-1', 1);
    expect(updated.version).toBe(2);
    expect(updated.markdown).toContain('new-conversation-review');
    expect(updated.markdown).not.toContain('competing-overwrite');
  });
  it('rejects another conversation plan and higher revision computed before the customer context advanced', async () => {
    const { stub, basis } = await setup('apply');
    const command = { ...validCommand, sourceRefs: [source] };
    const plan = { ...validPlan, orderedCommands: [command], sourceRefs: [source], workId: basis.lease.workId };
    await stub.savePlan(plan, basis);
    const nextBasis = await conversationBasis(stub, 0);
    await stub.saveContextProjection(projection(), nextBasis);
    await stub.refreshCustomerContext('opaque-customer-1', 0);
    const actor = { ...basis.lease.owner, scopes: ['automation:process', 'crm:create'], expiresAt: Date.now() + 60_000 };
    const authorization = { plan, actor, commandCapabilities: [{ commandKey: validCommand.commandKey, capabilities: ['crm:create' as const] }], validUntil: new Date(actor.expiresAt).toISOString() };
    await rejectCode(stub, instance => instance.reserveCommand({ ...basis, operationId: 'old-operation', command, authorization, expectedVersion: 1, payloadDigest: 'old-command' }), 'PLAN_STALE');
    await rejectCode(stub, instance => instance.savePlan({ ...plan, version: 2 }, basis), 'CONTEXT_STALE');
    expect(await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec('SELECT command_key FROM commands').toArray())).toEqual([]);
  });
  it('retains confirmed and uncertain historical receipts from other customer work', async () => {
    const { stub, basis } = await setup();
    await stub.savePlan({ ...validPlan, orderedCommands: [{ ...validCommand, sourceRefs: [source] }], sourceRefs: [source], workId: basis.lease.workId }, basis);
    await runInDurableObject(stub, (_instance, ctx) => {
      for (const receipt of [{ operationId: 'historical-confirmed', commandKey: 'old-confirmed', state: 'confirmed', crmRef: { kind: 'organization', id: 11 }, checkedAt: verifiedAt, updatedFields: ['name'] }, { operationId: 'historical-uncertain', commandKey: 'old-uncertain', state: 'uncertain', updatedFields: [] }]) {
        ctx.storage.sql.exec('INSERT INTO commands VALUES (?, ?, ?, ?, ?, 1, ?, ?)', receipt.commandKey, receipt.operationId, basis.lease.workId, 'receipt-digest', basis.lease.fence, receipt.state, JSON.stringify(receipt));
      }
    });
    const nextBasis = await conversationBasis(stub, 0);
    await stub.saveContextProjection(projection(), nextBasis);
    const context = await stub.refreshCustomerContext('opaque-customer-1', 0);
    expect(context.markdown).toContain('old-confirmed: confirmado');
    expect(context.markdown).toContain('old-uncertain: uncertain');
    expect(context.markdown).not.toContain('old-uncertain: confirmado');
  });
  it.each(['confirmed', 'uncertain'] as const)('recovers a legacy %s tombstone from its stored customer work target without a published context', async receiptState => {
    const { stub, basis } = await setup('apply');
    const command = { ...validCommand, sourceRefs: [source] };
    const plan = { ...validPlan, orderedCommands: [command], sourceRefs: [source], workId: basis.lease.workId };
    await stub.savePlan(plan, basis);
    const actor = { ...basis.lease.owner, scopes: ['automation:process', 'crm:create'], expiresAt: Date.now() + 60_000 };
    const reservation = { ...basis, operationId: 'legacy-operation', command, authorization: { plan, actor, commandCapabilities: [{ commandKey: command.commandKey, capabilities: ['crm:create' as const] }], validUntil: new Date(actor.expiresAt).toISOString() }, expectedVersion: 1, payloadDigest: 'legacy-command' };
    await stub.reserveCommand(reservation);
    await stub.completeCommand({ operationId: reservation.operationId, commandKey: command.commandKey, expectedVersion: 1, fence: basis.lease.fence, receipt: { operationId: reservation.operationId, commandKey: command.commandKey, state: receiptState, updatedFields: [], ...(receiptState === 'confirmed' ? { crmRef: { kind: 'organization' as const, id: 11 }, checkedAt: verifiedAt } : {}) } });
    const nextBasis = await conversationBasis(stub, 0);
    // Recreate the pre-v3 shape. There is deliberately no context row from
    // which migration 3 could recover the original customer association.
    await runInDurableObject(stub, (_instance, ctx) => {
      ctx.storage.sql.exec('DROP TABLE work_customers; DROP TABLE execution_commands; DROP TABLE execution_operations; DELETE FROM schema_migrations WHERE version >= 3');
      ctx.storage.sql.exec('INSERT INTO work VALUES (?, ?, ?, ?, ?, ?, ?)', 'ambiguous-work', 'ambiguous-request', 'digest', 'ambiguous-target', JSON.stringify({ ...basis.lease, workId: 'different-work-id' }), Date.now() + 60_000, 1);
      ctx.storage.sql.exec('INSERT INTO work VALUES (?, ?, ?, ?, ?, ?, ?)', 'malformed-work', 'malformed-request', 'digest', 'malformed-target', '{invalid-json', Date.now() + 60_000, 1);
    });
    await evictDurableObject(stub);
    const replay = await runInDurableObject(stub, async instance => {
      try { return (await instance.reserveCommand(reservation)).state; }
      catch (error) { return (error as Error).message; }
    });
    expect(replay).toBe(receiptState === 'confirmed' ? 'already_confirmed' : 'uncertain');
    const associations = await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec('SELECT work_id, customer_id FROM work_customers').toArray());
    expect(associations).toEqual([{ work_id: basis.lease.workId, customer_id: 'opaque-customer-1' }]);
    await stub.saveContextProjection(projection(), nextBasis);
    const context = await stub.refreshCustomerContext('opaque-customer-1', 0);
    expect(context.markdown).toContain(`${command.commandKey}: ${receiptState === 'confirmed' ? 'confirmado' : 'uncertain'}`);
    await evictDurableObject(stub);
    expect(await stub.reserveCommand(reservation)).toMatchObject({ state: receiptState === 'confirmed' ? 'already_confirmed' : 'uncertain' });
  });
});
