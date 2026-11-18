import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { runPlan, resumeOperation } from '../src/automation/executor';
import { reconcileCommand } from '../src/automation/reconciliation';
import type { MutationCommand } from '../src/automation/types';
import { validCommand } from './fixtures/automation';
import { executionFixture } from './fixtures/execution';

describe('recoverable plan execution', () => {
  it('reserves before dispatch, reads back the receipt, and replays without another POST', async () => {
    const f = await executionFixture();
    f.write.mockImplementation(async () => {
      const ledger = await f.stub.getExecutionCommand(validCommand.commandKey);
      expect(ledger?.state).toBe('sending');
      return { state: 'confirmed', ref: { kind: 'organization', id: 99 }, returnedFields: {} };
    });
    expect(await runPlan(f.authorization, f.deps)).toMatchObject({ state: 'applied', receipts: [{ state: 'confirmed', crmRef: { id: 99 }, checkedAt: expect.any(String) }] });
    await evictDurableObject(f.stub);
    expect((await runPlan(f.authorization, f.deps)).state).toBe('applied');
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.verify.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  it('rejects requestId reuse for a different plan and serializes competing executions', async () => {
    const f = await executionFixture();
    const results = await Promise.all([runPlan(f.authorization, f.deps), runPlan(f.authorization, f.deps)]);
    expect(results.some(r => r.state === 'applied')).toBe(true);
    expect(f.write).toHaveBeenCalledTimes(1);
    const conflict = await runInDurableObject(f.stub, async instance => {
      try { await runPlan({ ...f.authorization, plan: { ...f.authorization.plan, planId: 'other-plan' } }, { ...f.deps, repository: instance }); return ''; }
      catch (error) { return error instanceof Error ? error.message : ''; }
    });
    expect(conflict).toContain('IDEMPOTENCY_CONFLICT');
  });
  it('keeps timeout uncertainty across eviction and only reconciles with GET', async () => {
    const f = await executionFixture();
    f.write.mockResolvedValue({ state: 'uncertain', reason: 'UPSTREAM_TIMEOUT' } as never);
    expect((await runPlan(f.authorization, f.deps)).state).toBe('uncertain');
    await evictDurableObject(f.stub);
    expect((await runPlan(f.authorization, f.deps)).state).toBe('review');
    expect(f.write).toHaveBeenCalledTimes(1);
    const ledger = await f.stub.getExecutionCommand(validCommand.commandKey);
    expect(ledger?.attempts).toBe(1);
  });
  it('adopts only one proven create match, including after authorization expiry', async () => {
    const f = await executionFixture();
    f.write.mockResolvedValue({ state: 'uncertain', reason: 'UPSTREAM_TIMEOUT' } as never);
    await runPlan(f.authorization, f.deps);
    f.deps.reads.searchOrganizations = vi.fn(async () => ({ items: [{ id: 99, name: 'Synthetic Organization', cnpj: '12345678000199' }], pageInfo: { page: 1, perPage: 100, hasNext: false, nextPage: null } }));
    // A name-only match is never proof that our POST created this record.
    expect((await reconcileCommand(validCommand.commandKey, f.deps)).state).toBe('review');
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it('does not send a PUT after an external edit, or the next command after policy pause', async () => {
    const { payload: _payload, ...meta } = validCommand as Extract<MutationCommand, { kind: 'create_organization' }>;
    const command: MutationCommand = { ...meta, kind: 'enrich_organization', target: { kind: 'organization', id: 99 }, patch: { name: 'New name' }, requiredCapabilities: ['crm:enrich'] };
    const edited = await executionFixture([command]); edited.verify.mockResolvedValue(['CRM_CHANGED']);
    expect((await runPlan(edited.authorization, edited.deps)).state).toBe('review'); expect(edited.write).not.toHaveBeenCalled();
    const f = await executionFixture([validCommand, { ...validCommand, commandKey: 'second' }]);
    f.verify.mockImplementation(async () => f.write.mock.calls.length ? ['POLICY_PAUSED'] : []);
    expect((await runPlan(f.authorization, f.deps)).state).toBe('review'); expect(f.write).toHaveBeenCalledTimes(1);
  });
  it('enforces validUntil immediately before dispatch and rejects preview', async () => {
    const f = await executionFixture(); f.authorization.validUntil = new Date(Date.now() - 1).toISOString();
    expect((await runPlan(f.authorization, f.deps)).state).toBe('authorization_expired'); expect(f.write).not.toHaveBeenCalled();
    const p = await executionFixture(); p.deps.basis.lease.mode = 'preview';
    await expect(runPlan(p.authorization, p.deps)).rejects.toThrow('PREVIEW'); expect(p.write).not.toHaveBeenCalled();
  });
  it('treats a crash after POST before saving as uncertain without dispatching again', async () => {
    const f = await executionFixture();
    f.write.mockImplementation(async () => { throw Error('simulated process loss'); });
    expect((await runPlan(f.authorization, f.deps)).state).toBe('uncertain');
    await evictDurableObject(f.stub);
    await runPlan(f.authorization, f.deps); expect(f.write).toHaveBeenCalledTimes(1);
  });
  it('resolves dependency references from this operation only', async () => {
    const child: MutationCommand = { ...validCommand, kind: 'create_person', commandKey: 'person', dependencies: [validCommand.commandKey], target: { kind: 'organization', commandKey: validCommand.commandKey }, payload: { name: 'Synthetic person' } };
    const f = await executionFixture([validCommand, child]);
    f.deps.mutations.createPerson = vi.fn(async record => { expect(record.organization).toBe(99); return { state: 'confirmed' as const, ref: { kind: 'person' as const, id: 100 }, returnedFields: {} }; });
    f.deps.reads.getPerson = vi.fn(async () => ({ id: 100, name: 'Synthetic person', organization: 99 }));
    expect((await runPlan(f.authorization, f.deps)).state).toBe('applied');
  });
  it('recovers an abandoned sending claim with GET proof after expiry, never another POST', async () => {
    const command: MutationCommand = { ...validCommand, kind: 'create_organization', payload: { name: 'Synthetic Organization', cnpj: '12345678000199' } };
    const f = await executionFixture([command]);
    const op = await runPlan(f.authorization, { ...f.deps, defer: true });
    await f.stub.beginDispatch(op.operationId, command.commandKey);
    await runInDurableObject(f.stub, (_instance, ctx) => {
      ctx.storage.sql.exec('UPDATE execution_commands SET next_attempt_at = 0');
      const row = ctx.storage.sql.exec<{ data: string }>('SELECT data FROM execution_operations').one();
      const stored = JSON.parse(row.data); stored.input.authorization.validUntil = new Date(0).toISOString();
      ctx.storage.sql.exec('UPDATE execution_operations SET data = ?', JSON.stringify(stored));
    });
    f.deps.reads.searchOrganizations = vi.fn(async () => ({ items: [{ id: 99, name: 'Synthetic Organization', cnpj: '12345678000199' }], pageInfo: { page: 1, perPage: 100, hasNext: false, nextPage: null } }));
    f.read.mockResolvedValue({ id: 99, name: 'Synthetic Organization', cnpj: '12345678000199' } as never);
    await evictDurableObject(f.stub);
    const stored = await f.stub.getOperation(op.operationId);
    expect((await resumeOperation(stored!, f.deps)).state).toBe('applied'); expect(f.write).not.toHaveBeenCalled();
  });
  it('requires renewed interactive authorization to resume expired reserved writes', async () => {
    const f = await executionFixture(); const op = await runPlan(f.authorization, { ...f.deps, defer: true });
    await runInDurableObject(f.stub, (_instance, ctx) => {
      const row = ctx.storage.sql.exec<{ data: string }>('SELECT data FROM execution_operations').one();
      const stored = JSON.parse(row.data); stored.input.authorization.validUntil = new Date(0).toISOString();
      ctx.storage.sql.exec('UPDATE execution_operations SET data = ?', JSON.stringify(stored));
    });
    expect((await resumeOperation((await f.stub.getOperation(op.operationId))!, f.deps)).state).toBe('authorization_expired'); expect(f.write).not.toHaveBeenCalled();
    expect((await runPlan(f.authorization, f.deps)).state).toBe('applied'); expect(f.write).toHaveBeenCalledOnce();
  });
  it('never confirms a receipt whose CRM entity kind differs from the command', async () => {
    const f = await executionFixture();
    f.write.mockResolvedValue({ state: 'confirmed', ref: { kind: 'person', id: 99 }, returnedFields: {} });
    expect((await runPlan(f.authorization, f.deps)).state).toBe('uncertain');
  });
  it.each(['multiple', 'partial'])('sends uncertain creates to review for %s reconciliation matches', async condition => {
    const command: MutationCommand = { ...validCommand, kind: 'create_organization', payload: { name: 'Synthetic Organization', cnpj: '12345678000199' } };
    const f = await executionFixture([command]); f.write.mockResolvedValue({ state: 'uncertain', reason: 'UPSTREAM_TIMEOUT' });
    await runPlan(f.authorization, f.deps);
    f.deps.reads.searchOrganizations = vi.fn(async () => ({ items: [99, ...(condition === 'multiple' ? [100] : [])].map(id => ({ id, name: 'Synthetic Organization', cnpj: '12345678000199' })), pageInfo: { page: 1, perPage: 100, hasNext: condition === 'partial', nextPage: condition === 'partial' ? 1 : null } }));
    expect((await reconcileCommand(command.commandKey, f.deps)).state).toBe('review'); expect(f.write).toHaveBeenCalledOnce();
  });
  it('treats cancellation after send as uncertain and blocks subsequent writes', async () => {
    const f = await executionFixture([validCommand, { ...validCommand, commandKey: 'next' }]); const controller = new AbortController();
    f.deps.signal = controller.signal;
    f.write.mockImplementation(async () => { controller.abort(); return { state: 'confirmed', ref: { kind: 'organization', id: 99 }, returnedFields: {} }; });
    expect((await runPlan(f.authorization, f.deps)).state).toBe('uncertain'); expect(f.write).toHaveBeenCalledOnce();
  });
});
