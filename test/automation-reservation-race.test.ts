import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { runPlan } from '../src/automation/execution/executor';
import { OperationsStore } from '../src/automation/operations';
import type { ReservationResult } from '../src/automation/types';
import { validCommand } from './fixtures/automation';
import { executionFixture } from './fixtures/execution';

// The concurrent runPlan test in automation-executor.test.ts reaches either the
// "already stored" or the "raced" path of reserveExecutionCommand depending on
// scheduling. These tests pin each path so coverage does not depend on load.
describe('execution command reservation', () => {
  it('returns the stored command when a later call finds it already reserved', async () => {
    const f = await executionFixture();
    const operation = await runPlan(f.authorization, { ...f.deps, defer: true });
    const first = await f.stub.reserveExecutionCommand(operation.operationId, validCommand.commandKey);
    const again = await f.stub.reserveExecutionCommand(operation.operationId, validCommand.commandKey);
    expect(again).toEqual(first);
  });

  it('keeps the first record when two calls race through the reservation hook', async () => {
    const f = await executionFixture();
    const operation = await f.stub.prepareOperation({
      requestId: f.deps.requestId,
      accountKey: f.deps.accountKey,
      basis: f.deps.basis,
      catalogJson: JSON.stringify(f.deps.catalog),
      authorization: f.authorization,
    });
    await runInDurableObject(f.stub, async (_instance, ctx) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const reserve = vi.fn(async (): Promise<ReservationResult> => {
        await gate;
        return { state: 'reserved', version: reserve.mock.calls.length, fence: f.deps.basis.lease.fence };
      });
      const store = new OperationsStore(ctx.storage, { reserve, assert: vi.fn() });

      // Both calls pass the "already stored" check before either reservation resolves.
      const first = store.reserveExecutionCommand(operation.operationId, validCommand.commandKey);
      const second = store.reserveExecutionCommand(operation.operationId, validCommand.commandKey);
      await vi.waitFor(() => expect(reserve).toHaveBeenCalledTimes(2));
      release();

      const [winner, raced] = await Promise.all([first, second]);
      expect(raced).toEqual(winner);
      expect(winner.reservationVersion).toBe(2);
      expect(store.getExecutionCommand(validCommand.commandKey)).toEqual(winner);
    });
  });
});
