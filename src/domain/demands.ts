import type { AgentAnalysis } from './schemas/analysis';
import type { CustomerResolution, DemandRecord, DemandResolution } from './schemas/planning';
import { uniqueSources } from './identity';
const sameReference = (
  a: NonNullable<DemandRecord['references']>[number],
  b: NonNullable<DemandRecord['references']>[number],
) => a.kind === b.kind && a.value.normalize('NFKC').trim() === b.value.normalize('NFKC').trim();
const sameSource = (a: DemandRecord['sourceRefs'][number], b: DemandRecord['sourceRefs'][number]) =>
  a.kind === b.kind && a.id === b.id && a.revision === b.revision && a.field === b.field;
/** Similar service or a clientKey alone never establishes request identity. */
export function resolveDemands(
  input: AgentAnalysis,
  customer: CustomerResolution,
  existing: readonly DemandRecord[],
): DemandResolution {
  const created: { demandId: string; references: NonNullable<DemandRecord['references']> }[] = [];
  const demands: DemandResolution['demands'] = input.demands.map((request) => {
    const sourceRefs = uniqueSources([
      ...request.explicitRequest.sources,
      ...request.approach.sources,
      ...request.stage.sources,
      ...(request.references ?? []).flatMap((r) => r.sources),
      ...request.items.flatMap((i) => i.sources),
      ...request.commitments.flatMap((c) => c.sources),
    ]);
    const review = (...reviewReasons: string[]): DemandResolution['demands'][number] => ({
      kind: 'review',
      clientKey: request.clientKey,
      sourceRefs,
      reviewReasons,
    });
    if (customer.kind === 'review') return review('CUSTOMER_NEEDS_REVIEW');
    if (input.ambiguities.some((a) => !a.clientKey || a.clientKey === request.clientKey))
      return review('DEMAND_AMBIGUOUS');
    const owned = existing.filter((d) => d.customerId === customer.customerId);
    const references = request.references ?? [];
    const proven = owned.filter(
      (d) =>
        references.some((r) => d.references?.some((previous) => sameReference(r, previous))) ||
        (d.clientKey === request.clientKey &&
          request.explicitRequest.sources.some((r) => d.sourceRefs.some((previous) => sameSource(r, previous)))),
    );
    if (request.existingDemandId) {
      const claimed = owned.filter((d) => d.demandId === request.existingDemandId);
      if (claimed.length !== 1 || !proven.some((d) => d.demandId === request.existingDemandId))
        return review('DEMAND_LINK_UNPROVEN');
    }
    const ids = [...new Set(proven.map((d) => d.demandId))];
    if (ids.length > 1) return review('DEMAND_REFERENCE_AMBIGUOUS');
    const match = proven[0];
    if (match) {
      if (match.state !== 'open') return review('DEMAND_CLOSED_REQUIRES_REVIEW');
      return {
        kind: 'resolved',
        clientKey: request.clientKey,
        demandId: match.demandId,
        sourceRefs,
        reviewReasons: [],
      };
    }
    if (!request.explicitRequest.value) return review('EXPLICIT_REQUEST_REQUIRED');
    const earlier = created.filter((d) =>
      references.some((r) => d.references.some((previous) => sameReference(r, previous))),
    );
    if (new Set(earlier.map((d) => d.demandId)).size > 1) return review('DEMAND_REFERENCE_AMBIGUOUS');
    const demandId = earlier[0]?.demandId ?? crypto.randomUUID();
    created.push({ demandId, references });
    return {
      kind: 'create',
      clientKey: request.clientKey,
      demandId,
      sourceRefs,
      reviewReasons: request.approach.value === 'unknown' ? ['DEMAND_APPROACH_UNKNOWN'] : [],
    };
  });
  return { demands, reviewReasons: [...new Set(demands.flatMap((d) => d.reviewReasons))] };
}
