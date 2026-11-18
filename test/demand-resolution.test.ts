import { describe, expect, it } from 'vitest';
import * as demands from '../src/domain/demands';
import type { AgentAnalysis, CustomerResolution } from '../src/automation/types';
import { buildAnalysis, buildDemand, buildDemandRecord, buildSourceRef } from './fixtures/builders';

const source = buildSourceRef();
const customer: CustomerResolution = {
  kind: 'resolved',
  customerId: 'backend-customer',
  ref: { kind: 'organization', id: 11 },
  sourceRefs: [source],
  reviewReasons: [],
};
const request = buildDemand();
const input = (items: AgentAnalysis['demands']): AgentAnalysis => buildAnalysis({ demands: items });

describe('demand identity', () => {
  it('associates later data in another conversation through a proven request reference', () => {
    const reference = { kind: 'order' as const, value: 'ORDER-123', sources: [source] };
    const result = demands.resolveDemands(
      input([{ ...request, clientKey: 'later-data', references: [reference] }]),
      customer,
      [buildDemandRecord({ references: [reference] })],
    );
    expect(result.demands[0]).toMatchObject({ kind: 'resolved', demandId: 'permanent-demand' });
  });

  it('does not merge independent requests just because clientKey, customer and service match', () => {
    const result = demands.resolveDemands(
      input([
        buildDemand({
          clientKey: 'prior-key',
          explicitRequest: { value: true, sources: [buildSourceRef({ id: '102:300' })] },
          stage: { ...request.stage, sources: [buildSourceRef({ id: '102:300' })] },
        }),
      ]),
      customer,
      [buildDemandRecord()],
    );
    expect(result.demands[0]).toMatchObject({ kind: 'create' });
    expect(result.demands[0]).not.toHaveProperty('demandId', 'permanent-demand');
  });

  it('retains two separate requests with identical service and combines services only by explicit reference', () => {
    const result = demands.resolveDemands(input([request, buildDemand({ clientKey: 'request-b' })]), customer, []);
    expect(result.demands.filter((d) => d.kind === 'create')).toHaveLength(2);
    expect(new Set(result.demands.map((d) => ('demandId' in d ? d.demandId : '')))).toHaveLength(2);

    const reference = { kind: 'proposal' as const, value: 'P-9', sources: [source] };
    const combined = demands.resolveDemands(
      input([
        buildDemand({ references: [reference] }),
        buildDemand({ clientKey: 'service-b', service: 'Other service', references: [reference] }),
      ]),
      customer,
      [],
    );
    expect(combined.demands[0]).toHaveProperty('demandId');
    expect(combined.demands[1]).toHaveProperty(
      'demandId',
      'demandId' in combined.demands[0]! ? combined.demands[0].demandId : '',
    );
  });

  it('new explicit requests after a closed deal remain new, but a claimed closed demand needs review', () => {
    expect(
      demands.resolveDemands(input([request]), customer, [buildDemandRecord({ state: 'won' })]).demands[0]?.kind,
    ).toBe('create');
    expect(
      demands.resolveDemands(input([buildDemand({ existingDemandId: 'permanent-demand' })]), customer, [
        buildDemandRecord({ state: 'lost' }),
      ]).demands[0]?.kind,
    ).toBe('review');
  });

  it('does not trust existingDemandId without shared evidence or references and isolates ambiguity', () => {
    const result = demands.resolveDemands(
      input([buildDemand({ existingDemandId: 'foreign' }), buildDemand({ clientKey: 'safe' })]),
      customer,
      [buildDemandRecord({ demandId: 'foreign', customerId: 'other-customer' })],
    );
    expect(result.demands.map((d) => d.kind)).toEqual(['review', 'create']);

    const unrelated = buildSourceRef({ id: 'other:message' });
    expect(
      demands.resolveDemands(input([buildDemand({ existingDemandId: 'permanent-demand' })]), customer, [
        buildDemandRecord({ sourceRefs: [unrelated] }),
      ]).demands[0]?.kind,
    ).toBe('review');
  });

  it('retains partial requests internally and records an unknown approach for later planning', () => {
    for (const approach of ['client', 'elotenant', 'unknown'] as const) {
      const result = demands.resolveDemands(
        input([buildDemand({ approach: { ...request.approach, value: approach } })]),
        customer,
        [],
      );
      expect(result.demands[0]?.kind).toBe('create');
      if (approach === 'unknown') expect(result.demands[0]?.reviewReasons).toContain('DEMAND_APPROACH_UNKNOWN');
    }

    expect(
      demands.resolveDemands(
        input([request]),
        { kind: 'review', sourceRefs: [source], reviewReasons: ['IDENTITY_AMBIGUOUS'] },
        [],
      ).demands[0]?.kind,
    ).toBe('review');
  });

  it('reviews duplicate explicit references instead of selecting the first deal', () => {
    const reference = { kind: 'project' as const, value: 'PROJECT-1', sources: [source] };
    for (const records of [
      [
        buildDemandRecord({ references: [reference] }),
        buildDemandRecord({ demandId: 'second', references: [reference] }),
      ],
      [
        buildDemandRecord({ demandId: 'second', references: [reference] }),
        buildDemandRecord({ references: [reference] }),
      ],
    ]) {
      expect(
        demands.resolveDemands(input([buildDemand({ references: [reference] })]), customer, records).demands[0],
      ).toMatchObject({ kind: 'review', reviewReasons: ['DEMAND_REFERENCE_AMBIGUOUS'] });
    }
  });
});
