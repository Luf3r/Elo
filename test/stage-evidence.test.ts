import { describe, expect, it } from 'vitest';
import { decideStage } from '../src/automation/stages';
import type { DealSnapshot, StageEvidence, StageKey } from '../src/automation/types';
import { plannerCatalog, plannerPolicy, source } from './fixtures/planner';

const current: DealSnapshot = { ref: { kind: 'deal', id: 21 }, revision: 'deal-r1', status: 'open', funnelId: 10, stageId: 101, stage: 'new_request', fields: [] };
function evidence(requested: StageKey, event: string, changes = {}): StageEvidence {
  return { demandId: 'demand-a', requested, approach: 'client', explicitRequest: true, sourceRefs: [source], catalog: plannerCatalog, mapping: plannerPolicy.stageMapping, funnelMapping: plannerPolicy.funnelMapping,
    observations: [{ demandId: 'demand-a', event, actor: 'elotenant', direction: 'outgoing', sources: [source], ...changes }] } as StageEvidence;
}
describe('evidence-backed stage decisions', () => {
  it.each([
    ['new_request', 'request', 1], ['preparing_proposal', 'preparation', 2], ['internal_approval', 'internal_approval_pending', 3], ['proposal_sent', 'proposal_sent', 4],
  ] as const)('maps %s to the catalog sequence without simulating earlier stages', (stage, event, sequence) => {
    const result = decideStage(evidence(stage, event), { ...current, stageId: 100, stage: 'new_request' });
    expect(result.patch).toEqual({ funnel: 10, dealStage: sequence });
    expect(result.reviewReasons).toEqual([]);
  });
  it.each([
    ['internal_approval', 'client_approval', { actor: 'client' }],
    ['proposal_sent', 'future_send', {}],
    ['proposal_sent', 'proposal_sent', { actor: 'client', direction: 'incoming' }],
    ['proposal_sent', 'proposal_sent', { actor: 'third_party' }],
    ['proposal_sent', 'proposal_sent', { demandId: 'another-order' }],
    ['preparing_proposal', 'preparation', { actor: 'client' }],
  ] as const)('requires the corresponding Elo event for %s (%s)', (stage, event, changes) => {
    const result = decideStage(evidence(stage, event, changes), current);
    expect(result.patch).toBeUndefined();
    expect(result.reviewReasons).toContain('STAGE_EVIDENCE_INSUFFICIENT');
  });
  it('keeps completed internal approval until actual sending', () => {
    expect(decideStage(evidence('internal_approval', 'internal_approval_completed'), { ...current, stage: 'internal_approval', stageId: 103 }).patch).toBeUndefined();
  });
  it('routes regressions and funnel corrections to review', () => {
    expect(decideStage(evidence('preparing_proposal', 'preparation'), { ...current, stage: 'proposal_sent', stageId: 104 }).reviewReasons).toContain('STAGE_REGRESSION');
    expect(decideStage({ ...evidence('proposal_sent', 'proposal_sent'), approach: 'elotenant' }, current).reviewReasons).toContain('FUNNEL_CHANGE_REQUIRES_REVIEW');
  });
  it.each(['won', 'lost'] as const)('protects a %s deal', status => {
    expect(decideStage(evidence('proposal_sent', 'proposal_sent'), { ...current, status })).toMatchObject({ reviewReasons: ['DEAL_CLOSED'] });
  });
  it('rejects ambiguous mappings and missing sources', () => {
    const input = evidence('proposal_sent', 'proposal_sent');
    expect(decideStage({ ...input, mapping: [...input.mapping!, input.mapping![3]!] }, current).patch).toBeUndefined();
    expect(decideStage({ ...input, sourceRefs: [] }, current).patch).toBeUndefined();
  });
});
