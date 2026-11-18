import type { AgentAnalysis } from './types';
import type { WorkflowState } from './service-state';
import { canonical } from './operations';

/** A reviewed analysis is a single request, not an account-wide identity rule.
 * The original submission must be replayed exactly; new commercial requests
 * require separate work and cannot inherit this operator decision. */
export function applyReviewDecision(
  raw: AgentAnalysis,
  pending: NonNullable<WorkflowState['pendingReview']>,
): AgentAnalysis {
  if (canonical(raw) !== canonical(pending.analysis)) throw Error('REVIEW_ANALYSIS_CHANGED');
  const analysis = structuredClone(raw);
  const decision = pending.decision;
  if (decision.kind === 'selectCustomer') {
    analysis.customerSelection = decision.ref;
    analysis.ambiguities = analysis.ambiguities.filter(
      (a) => a.clientKey || !/^(CUSTOMER|IDENTITY|HOMONYM)(_|$)/i.test(a.code),
    );
  } else if (decision.kind === 'selectDemand') {
    const demand = analysis.demands.find((d) => d.clientKey === pending.clientKey);
    if (!demand) throw Error('REVIEW_DEMAND_SCOPE_INVALID');
    demand.existingDemandId = decision.demandId;
    analysis.ambiguities = analysis.ambiguities.filter(
      (a) => a.clientKey !== demand.clientKey || !/^DEMAND_(REFERENCE|LINK|IDENTITY|AMBIGUOUS)/i.test(a.code),
    );
  } else if (decision.kind === 'correctFacts') {
    const replaced = new Set(decision.facts.map((f) => canonical([f.entity, f.clientKey, f.field])));
    analysis.facts = [
      ...analysis.facts.filter((f) => !replaced.has(canonical([f.entity, f.clientKey, f.field]))),
      ...decision.facts,
    ];
    if (analysis.customerSelection.kind === 'new') {
      const selected = analysis.customerSelection;
      const name = decision.facts.find(
        (f) => f.entity === selected.entity && f.field === 'name' && f.certainty === 'confirmed',
      );
      if (name && typeof name.value === 'string') selected.record.name = name.value;
    }
  } else if (decision.kind === 'approvePlan') {
    // Acknowledges only ambiguities in this exact old analysis. Canonical source,
    // schema, customer, stage, scope and policy validation still run afterwards.
    analysis.ambiguities = [];
  }
  return analysis;
}
