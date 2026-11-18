import { resolveDemands } from '../domain/demands';
import { normalizedPhone, resolveCustomer, uniqueSources } from '../domain/identity';
import { applyReviewDecision } from '../domain/reviews';
import { canonical } from '../shared/canonical';
import { contextEvidenceRefs, renderCustomerContext } from './context/render';
import type { AutomationDomainHooks } from './state/account';
import type { ContextRenderOutput } from './state/repositories/context';
import type { ResolveWorkTransactionInput } from './state/repositories/customers';
import type { AgentAnalysis, ContextProjection, ResolutionBundle } from './types';

/** Extracts deterministic identity reservation keys from confirmed analysis facts and selection. */
export function extractIdentityKeys(analysis: AgentAnalysis): string[] {
  const identityValues: string[] = [];
  for (const fact of analysis.facts)
    if (fact.certainty === 'confirmed' && typeof fact.value === 'string') {
      if (fact.field === 'cnpj' && fact.entity === 'organization' && fact.value.replace(/\D/g, '').length === 14)
        identityValues.push('organization:cnpj:' + fact.value.replace(/\D/g, ''));
      if (fact.field === 'email') identityValues.push(fact.entity + ':email:' + fact.value.trim().toLowerCase());
      if (fact.field === 'phone' && normalizedPhone(fact.value))
        identityValues.push('phone:' + normalizedPhone(fact.value));
    }
  if (analysis.customerSelection.kind !== 'new')
    identityValues.push(`${analysis.customerSelection.kind}:${analysis.customerSelection.id}`);
  else if (!identityValues.length)
    identityValues.push(
      `${analysis.customerSelection.entity}:name-reservation:${analysis.customerSelection.record.name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR')}`,
    );
  return [...new Set(identityValues)].sort();
}

/** Pure domain decision function executed inside the repository transaction for work resolution. */
export function resolveWorkDecision(input: ResolveWorkTransactionInput): ResolutionBundle {
  const { rawAnalysis, analysis, candidates, catalog, basis, existingDemands, reservations, pendingReview } = input;
  let customer = resolveCustomer(analysis, candidates, catalog);
  if (pendingReview && canonical(rawAnalysis) !== canonical(applyReviewDecision(pendingReview.analysis, pendingReview)))
    throw Error('REVIEW_ANALYSIS_CHANGED');
  if (pendingReview?.decision.kind === 'selectCustomer') {
    const ref = pendingReview.decision.ref;
    const selected = candidates.candidates.find((c) => canonical(c.ref) === canonical(ref));
    if (!selected || !candidates.coverage.complete) throw Error('REVIEW_CUSTOMER_CHANGED');
    customer = {
      kind: 'resolved',
      customerId: basis.customerId,
      ref,
      sourceRefs: selected.sourceRefs,
      reviewReasons: [],
    };
  }
  if (customer.kind !== 'review') {
    const conflict = reservations.some((row) => row.customerId !== basis.customerId);
    if (conflict)
      customer = {
        kind: 'review',
        sourceRefs: customer.sourceRefs,
        reviewReasons: ['IDENTITY_RESERVED_FOR_OTHER_CUSTOMER'],
      };
    else if (customer.kind === 'create' && reservations.some((row) => row.workId !== basis.lease.workId))
      customer = { kind: 'review', sourceRefs: customer.sourceRefs, reviewReasons: ['IDENTITY_CREATION_PENDING'] };
  }
  const demands = resolveDemands(analysis, customer, existingDemands);
  if (pendingReview?.decision.kind === 'selectDemand' && customer.kind !== 'review') {
    const id = pendingReview.decision.demandId;
    const record = existingDemands.find((d) => d.demandId === id && d.state === 'open');
    const request = analysis.demands.find((d) => d.clientKey === pendingReview.clientKey);
    if (!record || !request) throw Error('REVIEW_DEMAND_CHANGED');
    demands.demands = demands.demands.map((d) =>
      d.clientKey === request.clientKey
        ? {
            kind: 'resolved' as const,
            clientKey: request.clientKey,
            demandId: id,
            sourceRefs: uniqueSources([
              ...request.explicitRequest.sources,
              ...request.approach.sources,
              ...request.stage.sources,
            ]),
            reviewReasons: [],
          }
        : d,
    );
    demands.reviewReasons = [...new Set(demands.demands.flatMap((d) => d.reviewReasons))];
  }
  return { customer, demands };
}

/** Pure projection renderer used inside context publication transactions. */
export function renderContextDocument(projection: ContextProjection): ContextRenderOutput {
  return {
    markdown: renderCustomerContext(projection),
    evidenceRefs: contextEvidenceRefs(projection),
  };
}

export const automationDomainHooks: AutomationDomainHooks = {
  resolveWork: {
    extractIdentityKeys,
    decide: resolveWorkDecision,
  },
  extractContextEvidenceRefs: contextEvidenceRefs,
  renderContext: renderContextDocument,
};
