import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { accountState } from '../src/automation/state/budget';
import type { PreparedWork } from '../src/automation/types';
import { scenarioAnalysis } from './fixtures/automation';
import { characterizationScenario, createSnapshotNormalizer, snapshotPlanner } from './characterization-helpers';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('characterization snapshots for automation preview flows and planner', () => {
  it('captures deferred and resumed automation_prepare_sync responses', async () => {
    const f = await characterizationScenario();
    const normalize = createSnapshotNormalizer();
    try {
      f.deferScope(2);
      const initial = {
        requestId: 'mcp-deferred-test',
        target: { kind: 'conversation', conversationId: 102 },
        mode: 'preview',
        inboxIds: [4101],
        limits: { maxMessagePages: 1, maxAttachmentPages: 0 },
      };
      const first = await f.tool<{
        state: string;
        workId: string;
        leaseToken: string;
        continuation: string;
      }>('automation_prepare_sync', initial);
      const resume = () => ({
        requestId: initial.requestId,
        workId: first.workId,
        leaseToken: first.leaseToken,
        continuation: first.continuation,
      });
      const immediateReplay = await f.tool('automation_prepare_sync', resume());
      const stub = f.env.AUTOMATION_STATE.get(accountState(f.env).id);
      const permitRetry = () =>
        runInDurableObject(stub, (_instance, ctx) =>
          ctx.storage.sql.exec(
            "UPDATE events SET data = json_set(data, '$.preparationDeferral.nextRetryAt', ?) WHERE event_id = ?",
            '2000-01-01T00:00:00.000Z',
            'workflow:' + first.workId,
          ),
        );
      await permitRetry();
      await evictDurableObject(stub);
      await f.reconnect();
      const secondDeferred = await f.tool('automation_prepare_sync', resume());
      await permitRetry();
      await evictDurableObject(stub);
      await f.reconnect();
      const ready = await f.tool('automation_prepare_sync', resume());
      expect(normalize({ first, immediateReplay, secondDeferred, ready })).toMatchSnapshot();
    } finally {
      await f.client.close();
    }
  });

  it('captures discovery prepare, planner, submit and empty replay across eviction', async () => {
    const stamp = Math.floor(Date.now() / 1000);
    let moved = false;
    const listing = vi.fn((request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/v1/accounts/123/inboxes') {
        return Promise.resolve(Response.json({ payload: [{ id: 4101 }, { id: 4102 }], links: { next: null } }));
      }
      const inbox = Number(url.searchParams.get('inbox_id'));
      return Promise.resolve(
        Response.json({
          data: {
            payload:
              inbox === 4101 ? [{ id: 102, inbox_id: moved ? 9999 : inbox, timestamp: stamp, status: 'open' }] : [],
          },
          links: { next: null },
        }),
      );
    });
    const f = await characterizationScenario({ discovery: listing });
    const normalize = createSnapshotNormalizer();
    try {
      const page = await f.tool<{ candidates: Array<{ prepare: Record<string, unknown> }> }>(
        'automation_discover_pending',
      );
      const candidate = page.candidates[0]!.prepare;
      moved = true;
      const prepareMovedError = await f.toolOutcome('automation_prepare_sync', candidate);
      moved = false;
      const prepareReady = await f.tool<{ state: string; work: PreparedWork }>('automation_prepare_sync', candidate);
      const analysis = scenarioAnalysis(prepareReady.work);
      await evictDurableObject(f.env.AUTOMATION_STATE.get(accountState(f.env).id));
      await f.reconnect();
      const submitPlan = await f.submit(analysis, prepareReady.work);
      const planner = await snapshotPlanner(f.env, prepareReady.work, normalize);
      await evictDurableObject(f.env.AUTOMATION_STATE.get(accountState(f.env).id));
      await f.reconnect();
      const submitReplay = await f.submit(analysis, prepareReady.work);
      const prepareAfterSubmit = await f.tool('automation_prepare_sync', candidate);
      const applyPreviewError = await f.toolOutcome('automation_apply_plan', {
        planId: submitPlan.planId,
        planVersion: submitPlan.version,
        requestId: 'forbidden-preview',
      });
      expect(
        normalize({
          prepareMovedError,
          prepareReady,
          planner,
          submitPlan,
          submitReplay,
          prepareAfterSubmit,
          applyPreviewError,
        }),
      ).toMatchSnapshot();
    } finally {
      await f.client.close();
    }
  });

  it('captures Phase B preview prepare, planner and review submit with explicit inbox and page caps', async () => {
    const f = await characterizationScenario();
    const normalize = createSnapshotNormalizer();
    try {
      const input = {
        target: { kind: 'conversation', conversationId: 102 },
        mode: 'preview',
        inboxIds: [4102],
        limits: { maxMessagePages: 1, maxAttachmentPages: 0 },
      };
      const prepareDenied = await f.toolOutcome('automation_prepare_sync', { ...input, requestId: 'phase-b-denied' });
      f.moveInbox(4102);
      const prepareReady = await f.tool<{ state: string; work: PreparedWork }>('automation_prepare_sync', {
        ...input,
        requestId: 'phase-b-denied',
      });
      const submitPlan = await f.submit(scenarioAnalysis(prepareReady.work), prepareReady.work);
      const planner = await snapshotPlanner(f.env, prepareReady.work, normalize);
      expect(normalize({ prepareDenied, prepareReady, planner, submitPlan })).toMatchSnapshot();
    } finally {
      await f.client.close();
    }
  });

  it.each(['organization', 'person'] as const)(
    'captures %s preview prepare, planner, submit with explicit task and apply rejection',
    async (entity) => {
      const f = await characterizationScenario();
      const normalize = createSnapshotNormalizer();
      try {
        const analysis = scenarioAnalysis(f.work, entity);
        const source = analysis.facts[0]!.sources[0]!;
        analysis.demands[0]!.commitments = [
          {
            text: 'Return tomorrow at 09:00',
            relativeDue: { days: 1, time: '09:00' },
            assignedUserId: 1,
            type: 'WHATSAPP',
            sources: [source],
          },
        ];
        const submitPlan = await f.submit(analysis);
        const planner = await snapshotPlanner(f.env, f.work, normalize);
        const applyPreviewError = await f.toolOutcome('automation_apply_plan', {
          planId: submitPlan.planId,
          planVersion: submitPlan.version,
          requestId: 'forbidden-preview',
        });
        expect(normalize({ prepared: f.prepared, planner, submitPlan, applyPreviewError })).toMatchSnapshot();
      } finally {
        await f.client.close();
      }
    },
  );

  it.each([
    ['new_request', undefined],
    ['preparing_proposal', 'preparation'],
    ['internal_approval', 'internal_approval_pending'],
    ['proposal_sent', 'proposal_sent'],
  ] as const)('captures stage %s planner and submit for passive and active requests', async (stage, event) => {
    const normalize = createSnapshotNormalizer();
    const results: Record<string, unknown> = {};
    for (const approach of ['client', 'elotenant'] as const) {
      const f = await characterizationScenario();
      try {
        const analysis = scenarioAnalysis(f.work);
        const demand = analysis.demands[0]!;
        demand.approach.value = approach;
        demand.stage.value = stage;
        if (event) {
          demand.stage.observations = [
            { demandKey: demand.clientKey, event, actor: 'elotenant', sources: demand.stage.sources },
          ];
        }
        const submitPlan = await f.submit(analysis);
        const planner = await snapshotPlanner(f.env, f.work, normalize);
        results[approach] = { planner, submitPlan };
      } finally {
        await f.client.close();
      }
    }
    expect(normalize(results)).toMatchSnapshot();
  });

  it.each([{ attachment: true }, { homonym: true }])(
    'captures review routing for prepare, planner and submit (%j)',
    async (options) => {
      const f = await characterizationScenario(options);
      const normalize = createSnapshotNormalizer();
      try {
        const submitPlan = await f.submit(scenarioAnalysis(f.work));
        const planner = await snapshotPlanner(f.env, f.work, normalize);
        expect(normalize({ prepared: f.prepared, planner, submitPlan })).toMatchSnapshot();
      } finally {
        await f.client.close();
      }
    },
  );

  it('captures validation error responses for malformed prepare and submit inputs', async () => {
    const f = await characterizationScenario();
    const normalize = createSnapshotNormalizer();
    try {
      const invented = scenarioAnalysis(f.work);
      invented.facts[0]!.sources[0]!.revision = 'invented';
      const inventedError = await f.toolOutcome('automation_submit_analysis', {
        workId: f.work.workId,
        leaseToken: f.work.leaseToken,
        expectedSnapshotVersion: f.work.snapshotVersion,
        expectedContextVersion: f.work.contextVersion,
        analysis: invented,
      });
      const oversized = scenarioAnalysis(f.work);
      oversized.facts[0]!.value = 'x'.repeat(600_000);
      const oversizedError = await f.toolOutcome('automation_submit_analysis', {
        workId: f.work.workId,
        leaseToken: f.work.leaseToken,
        expectedSnapshotVersion: f.work.snapshotVersion,
        expectedContextVersion: f.work.contextVersion,
        analysis: oversized,
      });
      const badPrepareError = await f.toolOutcome('automation_prepare_sync', {
        requestId: 'bad',
        target: { kind: 'conversation', conversationId: -1 },
        arbitraryUrl: 'https://attacker.invalid',
      });
      expect(normalize({ inventedError, oversizedError, badPrepareError })).toMatchSnapshot();
    } finally {
      await f.client.close();
    }
  });

  it('captures two independent explicit requests in one conversation', async () => {
    const f = await characterizationScenario();
    const normalize = createSnapshotNormalizer();
    try {
      const analysis = scenarioAnalysis(f.work);
      analysis.demands.push({
        ...structuredClone(analysis.demands[0]!),
        clientKey: 'request-b',
        service: 'Effluent analysis',
        scope: 'Independent collection',
      });
      const submitPlan = await f.submit(analysis);
      const planner = await snapshotPlanner(f.env, f.work, normalize);
      expect(normalize({ planner, submitPlan })).toMatchSnapshot();
    } finally {
      await f.client.close();
    }
  });

  it('captures review plan for client approval and unverified custom-field/collection facts', async () => {
    const f = await characterizationScenario();
    const normalize = createSnapshotNormalizer();
    try {
      const analysis = scenarioAnalysis(f.work);
      const demand = analysis.demands[0]!;
      const source = demand.stage.sources[0]!;
      demand.stage.value = 'internal_approval';
      demand.stage.observations = [
        { demandKey: demand.clientKey, event: 'client_approval', actor: 'client', sources: [source] },
      ];
      demand.items = [{ productId: 31, quantity: 4, unit: 'sample', sources: [source] }];
      analysis.facts.push({
        entity: 'demand',
        clientKey: demand.clientKey,
        field: 'customFields.logistics',
        value: 'included',
        certainty: 'confirmed',
        sources: [source],
      });
      const submitPlan = await f.submit(analysis);
      const planner = await snapshotPlanner(f.env, f.work, normalize);
      expect(normalize({ planner, submitPlan })).toMatchSnapshot();
    } finally {
      await f.client.close();
    }
  });
});
