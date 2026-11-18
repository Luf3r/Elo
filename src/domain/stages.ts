import type { StageEvidence, StageDecision, DealSnapshot, StageKey } from '../automation/types';
import { stageEvidenceSchemaForDecision, dealSnapshotSchema } from '../automation/schemas';
import { uniqueSources } from './identity';
const order: StageKey[] = ['new_request', 'preparing_proposal', 'internal_approval', 'proposal_sent'];

/** The agent interprets language. This pure gate checks scope, authorship,
 * direction, progression and catalog structure; it grants no approval. */
export function decideStage(evidence: StageEvidence, current: DealSnapshot): StageDecision {
  const result: StageDecision = { ref: current.ref, reviewReasons: [], sourceRefs: uniqueSources(evidence.sourceRefs) };
  const reject = (reason: string) => ({ ...result, reviewReasons: [reason] });
  if (!stageEvidenceSchemaForDecision.safeParse(evidence).success || !dealSnapshotSchema.safeParse(current).success)
    return reject('INVALID_STAGE_INPUT');
  if (current.status !== 'open') return reject('DEAL_CLOSED');
  if (current.demandId && current.demandId !== evidence.demandId) return reject('STAGE_DEMAND_MISMATCH');
  if (evidence.approach === 'unknown') return reject('DEMAND_APPROACH_UNKNOWN');
  const funnel = evidence.funnelMapping?.[evidence.approach];
  if (funnel === undefined) return reject('STAGE_MAPPING_INVALID');
  if (funnel !== undefined && funnel !== current.funnelId) return reject('FUNNEL_CHANGE_REQUIRES_REVIEW');
  if (order.indexOf(evidence.requested) < order.indexOf(current.stage)) return reject('STAGE_REGRESSION');
  const mapping =
    evidence.mapping?.filter((m) => m.funnelId === current.funnelId && m.stage === evidence.requested) ?? [];
  if (mapping.length !== 1 || !evidence.catalog?.funnels.some((f) => f.id === current.funnelId))
    return reject('STAGE_MAPPING_INVALID');
  const entries = evidence.catalog.stages.filter(
    (s) => s.funnelId === current.funnelId && s.id === mapping[0]!.stageId,
  );
  if (entries.length !== 1 || !Number.isInteger(entries[0]!.sequence) || entries[0]!.sequence <= 0)
    return reject('STAGE_MAPPING_INVALID');
  const events = {
    new_request: ['request'],
    preparing_proposal: ['preparation'],
    internal_approval: ['internal_approval_pending', 'internal_approval_completed'],
    proposal_sent: ['proposal_sent'],
  };
  const supported =
    evidence.requested === 'new_request'
      ? evidence.explicitRequest
      : evidence.observations?.some(
          (o) =>
            o.demandId === evidence.demandId &&
            o.actor === 'elotenant' &&
            events[evidence.requested].includes(o.event) &&
            (evidence.requested !== 'proposal_sent' || o.direction === 'outgoing') &&
            o.sources.every((ref) =>
              evidence.sourceRefs.some((source) => JSON.stringify(source) === JSON.stringify(ref)),
            ),
        );
  if (!supported) return reject('STAGE_EVIDENCE_INSUFFICIENT');
  if (current.stageId === entries[0]!.id) return result;
  return { ...result, patch: { funnel: current.funnelId, dealStage: entries[0]!.sequence } };
}
