import { describe, expect, it } from 'vitest';
import { buildSyncPlan, planDemand } from '../src/domain/planner';
import { buildFieldPatch, mergeManagedDescription } from '../src/domain/fields';
import { syncPlanSchema, createAnalysisInputSchema } from '../src/automation/schemas';
import { createCatalogSnapshot } from '../src/agendor/crm/catalog';
import type { Fact, FieldPatchInput } from '../src/automation/types';
import { buildFact, type SubmissionFact } from './fixtures/builders';
import {
  plannerAnalysis,
  plannerCatalog,
  plannerPolicy,
  plannerResolution,
  plannerWork,
  source,
} from './fixtures/planner';

const demandFact = (field: string, value: Fact['value'], changes: Partial<SubmissionFact> = {}): SubmissionFact =>
  buildFact({
    entity: 'demand',
    clientKey: 'request-a',
    field,
    value,
    sources: [source],
    ...changes,
  });

const patchInput = (facts: Fact[], changes: Partial<FieldPatchInput> = {}): FieldPatchInput => ({
  ref: { kind: 'deal', id: 21 },
  facts,
  current: [],
  catalog: plannerCatalog,
  policy: plannerPolicy,
  ...changes,
});

describe('pure CRM planner', () => {
  it.each([
    ['client', 10],
    ['elotenant', 20],
  ] as const)('uses %s demand origin, including a new request in an old conversation', (approach, funnel) => {
    const analysis = plannerAnalysis();
    analysis.demands[0]!.approach.value = approach;
    const work = plannerWork();
    work.snapshot.conversations[0]!.messages.unshift({
      id: 1,
      direction: approach === 'client' ? 'outgoing' : 'incoming',
      createdAt: 1600000000,
    });

    const plan = buildSyncPlan(analysis, work, plannerResolution, plannerPolicy);
    expect(plan.orderedCommands.find((c) => c.kind === 'change_stage')).toMatchObject({
      target: { kind: 'deal', commandKey: 'deal:demand-a' },
      patch: { funnel, dealStage: 1 },
    });
    expect(syncPlanSchema.safeParse(plan).success).toBe(true);
  });

  it('keeps unknown approach for review without a default funnel', () => {
    const analysis = plannerAnalysis();
    analysis.demands[0]!.approach.value = 'unknown';

    const plan = buildSyncPlan(analysis, plannerWork(), plannerResolution, plannerPolicy);
    expect(plan.state).toBe('review');
    expect(plan.orderedCommands).toEqual([]);
  });

  it('allows a deal without price, CNPJ or address and records missing value', () => {
    const analysis = plannerAnalysis();
    expect(planDemand(analysis, plannerWork(), plannerResolution, plannerPolicy, 'request-a')).toMatchObject({
      canCreateDeal: true,
      pendingFields: expect.arrayContaining(['value']),
    });

    const plan = buildSyncPlan(analysis, plannerWork(), plannerResolution, plannerPolicy);
    expect(plan.orderedCommands.find((c) => c.kind === 'create_deal')).toMatchObject({
      payload: { title: 'Synthetic analysis' },
    });
    expect(plan.orderedCommands.find((c) => c.kind === 'create_deal')).not.toHaveProperty('payload.value');
  });

  it('creates a new deal even when the mapped initial stage ID is one', () => {
    const work = plannerWork();
    work.snapshot.catalog.stages[0]!.id = 1;
    const policy = structuredClone(plannerPolicy);
    policy.stageMapping[0]!.stageId = 1;

    expect(
      buildSyncPlan(plannerAnalysis(), work, plannerResolution, policy).orderedCommands.some(
        (c) => c.kind === 'create_deal',
      ),
    ).toBe(true);
  });

  it('creates directly at a later evidenced stage and refuses an incoming proposal', () => {
    const analysis = plannerAnalysis();
    analysis.demands[0]!.stage = {
      value: 'proposal_sent',
      sources: [source],
      observations: [{ demandKey: 'request-a', event: 'proposal_sent', actor: 'elotenant', sources: [source] }],
    };

    expect(
      buildSyncPlan(analysis, plannerWork(), plannerResolution, plannerPolicy).orderedCommands.find(
        (c) => c.kind === 'change_stage',
      ),
    ).toMatchObject({ patch: { dealStage: 4 } });

    const work = plannerWork();
    work.snapshot.conversations[0]!.messages[0]!.direction = 'incoming';
    expect(buildSyncPlan(analysis, work, plannerResolution, plannerPolicy).orderedCommands).toEqual([]);
  });

  it('requires fresh source revisions, complete coverage and matching server customer identity', () => {
    const analysis = plannerAnalysis();

    const stale = plannerWork();
    stale.snapshot.conversations[0]!.revision = 'new-revision';
    expect(buildSyncPlan(analysis, stale, plannerResolution, plannerPolicy).orderedCommands).toEqual([]);

    const partial = plannerWork();
    partial.coverage.complete = false;
    expect(buildSyncPlan(analysis, partial, plannerResolution, plannerPolicy).orderedCommands).toEqual([]);

    const other = plannerWork();
    other.customerId = 'customer-other';
    expect(buildSyncPlan(analysis, other, plannerResolution, plannerPolicy).orderedCommands).toEqual([]);
  });

  it('keeps price-free product candidates pending without sending blocked collection writes', () => {
    const analysis = plannerAnalysis();
    analysis.demands[0]!.items = [{ productId: 31, quantity: 4, unit: 'amostra', sources: [source] }];

    const decision = planDemand(analysis, plannerWork(), plannerResolution, plannerPolicy, 'request-a');
    expect(decision.canCreateDeal).toBe(true);
    expect(decision.pendingFields).toContain('products_entities');
    expect(decision.commands.find((c) => c.kind === 'create_deal')).not.toHaveProperty('payload.products_entities');
    expect(decision.commands.find((c) => c.kind === 'create_deal')).not.toHaveProperty('payload.value');
  });

  it('only creates explicit assigned commitments and resolves tomorrow from message time in Cuiaba', () => {
    const analysis = plannerAnalysis();
    expect(
      buildSyncPlan(analysis, plannerWork(), plannerResolution, plannerPolicy).orderedCommands.some(
        (c) => c.kind === 'create_task',
      ),
    ).toBe(false);

    analysis.demands[0]!.commitments = [
      {
        text: 'Retornar amanhã às 09h',
        relativeDue: { days: 1, time: '09:00' },
        type: 'WHATSAPP',
        assignedUserId: 1,
        sources: [source],
      },
    ];
    const work = plannerWork();
    work.snapshot.conversations[0]!.messages[0]!.createdAt = Date.parse('2026-10-27T02:30:00Z') / 1000;

    const plan = buildSyncPlan(analysis, work, plannerResolution, plannerPolicy);
    expect(plan.orderedCommands.find((c) => c.kind === 'create_task')).toMatchObject({
      payload: { due_date: '2026-10-27T09:00:00-04:00', assigned_users: [1] },
    });

    analysis.demands[0]!.commitments[0]!.assignedUserId = 2;
    expect(
      buildSyncPlan(analysis, work, plannerResolution, plannerPolicy).orderedCommands.some(
        (c) => c.kind === 'create_task',
      ),
    ).toBe(false);
  });

  it('never applies demand facts to a different order or changes protected won/lost deals', () => {
    const analysis = plannerAnalysis();
    analysis.facts = [demandFact('value', 100, { clientKey: 'another-order' })];
    analysis.demands.push({ ...structuredClone(analysis.demands[0]!), clientKey: 'another-order' });
    expect(
      buildSyncPlan(analysis, plannerWork(), plannerResolution, plannerPolicy).orderedCommands.find(
        (c) => c.kind === 'create_deal',
      ),
    ).not.toHaveProperty('payload.value');

    const work = plannerWork();
    work.snapshot.deals = [
      {
        demandId: 'demand-a',
        ref: { kind: 'deal', id: 21 },
        revision: 'r1',
        status: 'won',
        funnelId: 10,
        stageId: 104,
        stage: 'proposal_sent',
        fields: [],
      },
    ];
    const resolution = structuredClone(plannerResolution);
    resolution.demands.demands[0]!.kind = 'resolved';
    expect(buildSyncPlan(analysis, work, resolution, plannerPolicy).orderedCommands).toEqual([]);
  });

  it('preserves review provenance and remains deterministic without changing inputs', () => {
    const analysis = plannerAnalysis();
    const work = plannerWork();
    const before = structuredClone({ analysis, work });
    const first = buildSyncPlan(analysis, work, plannerResolution, plannerPolicy);

    expect(buildSyncPlan(analysis, work, plannerResolution, plannerPolicy)).toEqual(first);
    expect({ analysis, work }).toEqual(before);
  });

  it('reports only actual changed values and retains independently safe commands', () => {
    const analysis = plannerAnalysis();
    analysis.facts = [demandFact('value', null), demandFact('customFields.sampleCount', 8)];

    const plan = buildSyncPlan(analysis, plannerWork(), plannerResolution, plannerPolicy);
    expect(plan.state).toBe('ready');
    expect(plan.reviewReasons).toContain('COLLECTION_WRITE_UNVERIFIED');
    expect(plan.after.some((f) => f.field === 'value' || f.field.startsWith('customFields.'))).toBe(false);
    expect(plan.after.find((f) => f.field === 'description')?.value).toContain('elotenant:auto:start');
  });

  it('uses persisted per-message revisions instead of deriving them from conversation revision', () => {
    const work = plannerWork();
    work.snapshot.sourceRefs = [{ ...source, revision: 'persisted-message-hash' }];
    const analysis = plannerAnalysis();
    for (const entry of [
      analysis.demands[0]!.stage,
      analysis.demands[0]!.approach,
      analysis.demands[0]!.explicitRequest,
    ]) {
      entry.sources = [{ ...source, revision: 'persisted-message-hash' }];
    }
    const resolution = structuredClone(plannerResolution);
    resolution.customer.sourceRefs = [...work.snapshot.sourceRefs];
    resolution.demands.demands[0]!.sourceRefs = [...work.snapshot.sourceRefs];

    expect(
      buildSyncPlan(analysis, work, resolution, plannerPolicy).orderedCommands.some((c) => c.kind === 'create_deal'),
    ).toBe(true);
  });

  it('creates an evidenced customer before dependent deals and tasks', () => {
    const analysis = plannerAnalysis();
    analysis.customerSelection = { kind: 'new', entity: 'organization', record: { name: 'Evidenced company' } };
    analysis.facts = [demandFact('name', 'Evidenced company', { entity: 'organization', clientKey: undefined })];

    const resolution = structuredClone(plannerResolution);
    resolution.customer = {
      kind: 'create',
      customerId: 'customer-1',
      proposal: analysis.customerSelection,
      sourceRefs: [source],
      reviewReasons: [],
    };

    const plan = buildSyncPlan(analysis, plannerWork(), resolution, plannerPolicy);
    expect(plan.orderedCommands.map((c) => c.kind)).toEqual(['create_organization', 'create_deal', 'change_stage']);
    expect(syncPlanSchema.safeParse(plan).success).toBe(true);
  });
});

describe('evidence-backed field patches', () => {
  it('preserves absent/null/ambiguous values and existing owner', () => {
    const result = buildFieldPatch(
      patchInput(
        [
          demandFact('value', null),
          demandFact('title', 'Maybe', { certainty: 'ambiguous' }),
          demandFact('ownerUser', 1),
        ],
        { current: [demandFact('value', 200), demandFact('ownerUser', 2)] },
      ),
    );
    expect(result.patch).toBeUndefined();
    expect(result.reviewReasons).toContain('FACT_AMBIGUOUS:title');
  });

  it('blocks observable human changes but permits an evidenced update to an unchanged automated value', () => {
    expect(
      buildFieldPatch(
        patchInput([demandFact('value', 300)], {
          current: [demandFact('value', 250)],
          lastWritten: [demandFact('value', 200)],
        }),
      ).reviewReasons,
    ).toContain('EXTERNAL_CHANGE:value');

    expect(
      buildFieldPatch(
        patchInput([demandFact('value', 300)], {
          current: [demandFact('value', 200)],
          lastWritten: [demandFact('value', 200)],
        }),
      ).patch,
    ).toMatchObject({ value: 300 });
  });

  it('validates custom mapping/options while retaining unverified collections as review', () => {
    const result = buildFieldPatch(
      patchInput([demandFact('customFields.sampleCount', 8), demandFact('customFields.logistics', 'included')]),
    );
    expect(result.patch).toBeUndefined();
    expect(result.reviewReasons).toContain('COLLECTION_WRITE_UNVERIFIED');
    expect(buildFieldPatch(patchInput([demandFact('customFields.logistics', 'invented')])).reviewReasons).toContain(
      'INVALID_CUSTOM_FIELD:logistics',
    );
    expect(
      buildFieldPatch(patchInput([demandFact('customFields.sampleCount', 8)], { policy: undefined })).reviewReasons,
    ).toContain('CUSTOM_FIELD_MAPPING_MISSING:sampleCount');
  });

  it('requires an unequivocally active owner and never copies collection site as registered address', () => {
    expect(buildFieldPatch(patchInput([demandFact('ownerUser', 1)])).patch).toEqual({ ownerUser: 1 });
    expect(buildFieldPatch(patchInput([demandFact('ownerUser', 2)])).patch).toBeUndefined();
  });

  it('keeps observed user activation through the real catalog adapter', () => {
    const catalog = createCatalogSnapshot({
      accountId: 'account',
      pages: [
        {
          section: 'users',
          items: [
            { id: 1, name: 'Active', active: true },
            { id: 2, name: 'Inactive', active: false },
            { id: 3, name: 'Unknown' },
          ],
          pageInfo: { page: 1, perPage: 100, hasNext: false, nextPage: null },
          fetchedAt: '2026-10-27T10:00:00Z',
          coverage: { status: 'partial', pages: [1] },
        },
      ],
    });
    expect(buildFieldPatch(patchInput([demandFact('ownerUser', 1)], { catalog })).patch).toEqual({ ownerUser: 1 });
    expect(buildFieldPatch(patchInput([demandFact('ownerUser', 2)], { catalog })).patch).toBeUndefined();
    expect(buildFieldPatch(patchInput([demandFact('ownerUser', 3)], { catalog })).patch).toBeUndefined();
  });

  it('keeps all human text when the managed description cannot fit', () => {
    const human = 'H'.repeat(1980);
    expect(mergeManagedDescription(human, 'New scope')).toMatchObject({ reviewReasons: ['DESCRIPTION_LIMIT'] });
    expect(mergeManagedDescription(human, 'New scope').description).toBeUndefined();

    const first = mergeManagedDescription('Human note', 'First scope').description!;
    expect(mergeManagedDescription(first, 'Second scope').description).toContain('Human note');
    expect(mergeManagedDescription(first, 'Second scope').description).not.toContain('First scope');
    expect(mergeManagedDescription('Human note', '<!-- elotenant:auto:end -->').description).toBeUndefined();
  });

  it('rejects conflicting facts and excludes untrusted selection payload fields', () => {
    expect(buildFieldPatch(patchInput([demandFact('value', 1), demandFact('value', 2)])).patch).toBeUndefined();

    const analysis = plannerAnalysis();
    analysis.customerSelection = { kind: 'new', entity: 'organization', record: { name: 'Unproven', ranking: 5 } };
    const resolution = structuredClone(plannerResolution);
    resolution.customer = {
      kind: 'create',
      customerId: 'customer-1',
      proposal: analysis.customerSelection,
      sourceRefs: [source],
      reviewReasons: [],
    };
    expect(buildSyncPlan(analysis, plannerWork(), resolution, plannerPolicy).orderedCommands).toEqual([]);
  });

  it('validates logical custom field facts through the configured catalog mapping', () => {
    const analysis = plannerAnalysis();
    analysis.facts = [demandFact('customFields.sampleCount', 8)];
    const context = {
      sourceRefs: [source],
      candidates: [{ kind: 'organization' as const, id: 11 }],
      existingDemandIds: [],
      catalog: plannerCatalog,
      policy: plannerPolicy,
    };
    expect(
      createAnalysisInputSchema(context).safeParse({
        workId: 'w',
        leaseToken: 'l',
        expectedSnapshotVersion: 1,
        expectedContextVersion: 0,
        analysis,
      }).success,
    ).toBe(true);
  });
});
