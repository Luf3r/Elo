import { describe, expect, it } from 'vitest';
import { applyReviewDecision } from '../../src/domain/reviews';
import type { PendingReview } from '../../src/domain/schemas/analysis';
import { buildAnalysis, buildDemand, buildFact, buildSourceRef } from '../fixtures/builders';

const source = buildSourceRef();

function makePending(decision: PendingReview['decision'], overrides: Partial<PendingReview> = {}): PendingReview {
  return {
    reviewId: 'review-1',
    version: 1,
    sourceSnapshotVersion: 1,
    sourceRefs: [source],
    policyVersion: 1,
    analysis: buildAnalysis({
      ambiguities: [
        { code: 'IDENTITY_AMBIGUOUS', description: 'Multiple candidates', sources: [source] },
        {
          code: 'DEMAND_REFERENCE_AMBIGUOUS',
          clientKey: 'request-a',
          description: 'Ambiguous demand',
          sources: [source],
        },
        { code: 'OTHER_NOTE', description: 'Retained note', sources: [source] },
      ],
    }),
    decision,
    ...overrides,
  };
}

describe('pure review decision application', () => {
  it('rejects replayed analysis that differs from the reviewed canonical analysis', () => {
    const pending = makePending({ kind: 'approvePlan', planId: 'plan-1', planVersion: 1 });
    const modified = buildAnalysis({ demands: [buildDemand({ service: 'Changed service' })] });
    expect(() => applyReviewDecision(modified, pending)).toThrow('REVIEW_ANALYSIS_CHANGED');
  });

  it('applies selectCustomer and removes only customer-level identity ambiguities', () => {
    const pending = makePending({ kind: 'selectCustomer', ref: { kind: 'person', id: 42 } });
    const raw = structuredClone(pending.analysis);
    const updated = applyReviewDecision(raw, pending);

    expect(updated.customerSelection).toEqual({ kind: 'person', id: 42 });
    expect(updated.ambiguities.map((a) => a.code)).toEqual(['DEMAND_REFERENCE_AMBIGUOUS', 'OTHER_NOTE']);
    expect(raw.customerSelection).toEqual({ kind: 'organization', id: 11 });
  });

  it('applies selectDemand to the matching clientKey and rejects missing targets', () => {
    const pending = makePending({ kind: 'selectDemand', demandId: 'demand-99' }, { clientKey: 'request-a' });
    const updated = applyReviewDecision(structuredClone(pending.analysis), pending);
    expect(updated.demands[0]?.existingDemandId).toBe('demand-99');
    expect(updated.ambiguities.map((a) => a.code)).toEqual(['IDENTITY_AMBIGUOUS', 'OTHER_NOTE']);

    const invalid = makePending({ kind: 'selectDemand', demandId: 'demand-99' }, { clientKey: 'missing-key' });
    expect(() => applyReviewDecision(structuredClone(invalid.analysis), invalid)).toThrow(
      'REVIEW_DEMAND_SCOPE_INVALID',
    );
  });

  it('replaces matching facts and updates new customer name when confirmed', () => {
    const initial = buildAnalysis({
      customerSelection: { kind: 'new', entity: 'organization', record: { name: 'Wrong Name' } },
      facts: [
        buildFact({ entity: 'organization', field: 'name', value: 'Wrong Name', certainty: 'ambiguous' }),
        buildFact({ entity: 'organization', field: 'cnpj', value: '12345678000190' }),
      ],
    });
    const pending = makePending(
      {
        kind: 'correctFacts',
        facts: [
          buildFact({ entity: 'organization', field: 'name', value: 'Corrected Name', sources: [source] }),
          buildFact({ entity: 'organization', field: 'email', value: 'fixed@example.test', sources: [source] }),
        ],
      },
      { analysis: structuredClone(initial) },
    );
    const updated = applyReviewDecision(initial, pending);

    expect(updated.customerSelection).toEqual({
      kind: 'new',
      entity: 'organization',
      record: { name: 'Corrected Name' },
    });
    expect(updated.facts).toHaveLength(3);
    expect(updated.facts.find((f) => f.field === 'name')?.value).toBe('Corrected Name');
    expect(updated.facts.find((f) => f.field === 'cnpj')?.value).toBe('12345678000190');
    expect(updated.facts.find((f) => f.field === 'email')?.value).toBe('fixed@example.test');
  });

  it('clears all ambiguities on approvePlan without mutating input', () => {
    const pending = makePending({ kind: 'approvePlan', planId: 'plan-1', planVersion: 1 });
    const raw = structuredClone(pending.analysis);
    const updated = applyReviewDecision(raw, pending);

    expect(updated.ambiguities).toEqual([]);
    expect(raw.ambiguities).toHaveLength(3);
  });
});
