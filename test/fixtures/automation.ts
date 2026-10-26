import type { CatalogSnapshot } from '../../src/agendor/crm/types';
import type { AnalysisInput, AnalysisValidationContext, MutationCommand, SyncPlan } from '../../src/automation/types';
export const catalogFixture: CatalogSnapshot = {
  version: 'catalog-1', accountId: 'synthetic-account', fetchedAt: '2026-10-26T10:00:00Z',
  funnels: [{ id: 1, name: 'Synthetic funnel' }], stages: [{ id: 2, name: 'Synthetic stage', sequence: 1, funnelId: 1 }],
  users: [{ id: 1, name: 'Synthetic owner' }], products: [{ id: 31, name: 'Synthetic service' }],
  customFields: [
    { id: 'cf-text', entityType: 'people', type: 'text', name: 'Synthetic text' },
    { id: 'cf-choice', entityType: 'people', type: 'select', name: 'Synthetic option', options: [{ id: 'option-a', name: 'Synthetic A' }] },
    { id: 'cf-company', entityType: 'organizations', type: 'text', name: 'Synthetic company field' },
  ], capabilities: { customFields: 'unverified', collectionWriteSemantics: 'unverified' }, coverage: {},
};
export const validationContext: AnalysisValidationContext = {
  sourceRefs: [{ kind: 'message', id: '101:201', revision: 'message-rev-1' }], candidates: [{ kind: 'organization', id: 11 }, { kind: 'person', id: 12 }],
  existingDemandIds: ['demand-1'], catalog: catalogFixture,
};
export const validAnalysisInput: AnalysisInput = {
  workId: 'work-1', leaseToken: 'lease-1', expectedSnapshotVersion: 1, expectedContextVersion: 0,
  analysis: {
    customerSelection: { kind: 'organization', id: 11 },
    facts: [{ entity: 'organization', field: 'name', value: 'Synthetic Organization', certainty: 'confirmed', sources: [{ kind: 'message', id: '101:201', revision: 'message-rev-1' }] }],
    demands: [{ clientKey: 'request-a', service: 'Synthetic analysis', scope: 'Synthetic scope', explicitRequest: { value: true, sources: [{ kind: 'message', id: '101:201', revision: 'message-rev-1' }] }, approach: { value: 'client', sources: [{ kind: 'message', id: '101:201', revision: 'message-rev-1' }] }, stage: { value: 'new_request', sources: [{ kind: 'message', id: '101:201', revision: 'message-rev-1' }] }, items: [], commitments: [] }], ambiguities: [],
  },
};
export const validCommand: MutationCommand = { kind: 'create_organization', commandKey: 'company-create', payload: { name: 'Synthetic Organization' }, dependencies: [], before: [], sourceRefs: [{ kind: 'message', id: '101:201', revision: 'message-rev-1' }], requiredCapabilities: ['crm:create'] };
export const validPlan: SyncPlan = { planId: 'plan-1', version: 1, policyVersion: 1, workId: 'work-1', analysisRevision: 1, orderedCommands: [validCommand], before: [], after: [], sourceRefs: [{ kind: 'message', id: '101:201', revision: 'message-rev-1' }], reviewIds: [], state: 'ready' };
