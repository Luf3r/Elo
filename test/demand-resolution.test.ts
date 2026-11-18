import { describe, expect, it } from 'vitest';
import * as demands from '../src/automation/demands';
import type { AgentAnalysis, CustomerResolution, DemandRecord } from '../src/automation/types';
import { validAnalysisInput } from './fixtures/automation';
const source = validAnalysisInput.analysis.facts[0]!.sources[0]!;
const customer: CustomerResolution = {
  kind: 'resolved',
  customerId: 'backend-customer',
  ref: { kind: 'organization', id: 11 },
  sourceRefs: [source],
  reviewReasons: [],
};
const request = validAnalysisInput.analysis.demands[0]!;
const input = (items: AgentAnalysis['demands']): AgentAnalysis => ({ ...validAnalysisInput.analysis, demands: items });
const existing = (patch: Partial<DemandRecord> = {}): DemandRecord => ({
  demandId: 'permanent-demand',
  customerId: 'backend-customer',
  clientKey: 'prior-key',
  service: request.service,
  scope: request.scope,
  state: 'open',
  sourceRefs: [source],
  ...patch,
});
describe('demand identity', () => {
  it('associates later data in another conversation through a proven request reference', () => {
    const reference = { kind: 'order' as const, value: 'ORDER-123', sources: [source] };
    const result = demands.resolveDemands(
      input([{ ...request, clientKey: 'later-data', references: [reference] }]),
      customer,
      [existing({ references: [reference] })],
    );
    expect(result.demands[0]).toMatchObject({ kind: 'resolved', demandId: 'permanent-demand' });
  });
  it('does not merge independent requests just because clientKey, customer and service match', () => {
    const result = demands.resolveDemands(
      input([
        {
          ...request,
          clientKey: 'prior-key',
          explicitRequest: { value: true, sources: [{ ...source, id: '102:300' }] },
          stage: { ...request.stage, sources: [{ ...source, id: '102:300' }] },
        },
      ]),
      customer,
      [existing()],
    );
    expect(result.demands[0]).toMatchObject({ kind: 'create' });
    expect(result.demands[0]).not.toHaveProperty('demandId', 'permanent-demand');
  });
  it('retains two separate requests with identical service and combines services only by explicit reference', () => {
    const result = demands.resolveDemands(input([request, { ...request, clientKey: 'request-b' }]), customer, []);
    expect(result.demands.filter((d) => d.kind === 'create')).toHaveLength(2);
    expect(new Set(result.demands.map((d) => ('demandId' in d ? d.demandId : '')))).toHaveLength(2);
    const reference = { kind: 'proposal' as const, value: 'P-9', sources: [source] };
    const combined = demands.resolveDemands(
      input([
        { ...request, references: [reference] },
        { ...request, clientKey: 'service-b', service: 'Other service', references: [reference] },
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
    expect(demands.resolveDemands(input([request]), customer, [existing({ state: 'won' })]).demands[0]?.kind).toBe(
      'create',
    );
    expect(
      demands.resolveDemands(input([{ ...request, existingDemandId: 'permanent-demand' }]), customer, [
        existing({ state: 'lost' }),
      ]).demands[0]?.kind,
    ).toBe('review');
  });
  it('does not trust existingDemandId without shared evidence or references and isolates ambiguity', () => {
    const result = demands.resolveDemands(
      input([
        { ...request, existingDemandId: 'foreign' },
        { ...request, clientKey: 'safe' },
      ]),
      customer,
      [existing({ demandId: 'foreign', customerId: 'other-customer' })],
    );
    expect(result.demands.map((d) => d.kind)).toEqual(['review', 'create']);
    const unrelated = { ...source, id: 'other:message' };
    expect(
      demands.resolveDemands(input([{ ...request, existingDemandId: 'permanent-demand' }]), customer, [
        existing({ sourceRefs: [unrelated] }),
      ]).demands[0]?.kind,
    ).toBe('review');
  });
  it('retains partial requests internally and records an unknown approach for later planning', () => {
    for (const approach of ['client', 'elotenant', 'unknown'] as const) {
      const result = demands.resolveDemands(
        input([{ ...request, approach: { ...request.approach, value: approach } }]),
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
      [existing({ references: [reference] }), existing({ demandId: 'second', references: [reference] })],
      [existing({ demandId: 'second', references: [reference] }), existing({ references: [reference] })],
    ]) {
      expect(
        demands.resolveDemands(input([{ ...request, references: [reference] }]), customer, records).demands[0],
      ).toMatchObject({ kind: 'review', reviewReasons: ['DEMAND_REFERENCE_AMBIGUOUS'] });
    }
  });
});
