import type {
  AutomationPolicy,
  CatalogSnapshot,
  PreparedWork,
  ResolutionBundle,
  SourceRef,
} from '../../src/automation/types';
import { catalogFixture, validAnalysisInput } from './automation';
export const source = { kind: 'message', id: '101:201', revision: 'message-r1' } as const satisfies SourceRef;
export const plannerCatalog: CatalogSnapshot = {
  ...catalogFixture,
  funnels: [
    { id: 10, name: 'Passivo' },
    { id: 20, name: 'Ativo' },
  ],
  stages: [10, 20].flatMap((funnelId) =>
    [1, 2, 3, 4].map((sequence) => ({ id: funnelId * 10 + sequence, sequence, funnelId, name: `Stage ${sequence}` })),
  ),
  users: [
    { id: 1, name: 'Active owner', active: true },
    { id: 2, name: 'Inactive owner', active: false },
  ],
  customFields: [
    ...catalogFixture.customFields,
    { id: 'samples', entityType: 'deals', type: 'number' },
    { id: 'logistics', entityType: 'deals', type: 'select', options: [{ id: 'included', name: 'Incluída' }] },
  ],
};
export const plannerPolicy: AutomationPolicy = {
  version: 1,
  mode: 'preview',
  allowedInboxIds: [4101, 4102],
  capabilities: ['crm:read', 'chat:read', 'crm:create', 'crm:enrich', 'crm:write'],
  funnelMapping: { client: 10, elotenant: 20 },
  stageMapping: [10, 20].flatMap((funnelId) =>
    (['new_request', 'preparing_proposal', 'internal_approval', 'proposal_sent'] as const).map((stage, i) => ({
      funnelId,
      stage,
      stageId: funnelId * 10 + i + 1,
    })),
  ),
  customFieldMapping: [
    { entity: 'deals', field: 'sampleCount', catalogFieldId: 'samples' },
    { entity: 'deals', field: 'logistics', catalogFieldId: 'logistics' },
  ],
  nativeCreatorDisabled: true,
  limits: { maxConversations: 100, maxCommands: 100, maxRequests: 100 },
};
export function plannerAnalysis() {
  const analysis = structuredClone(validAnalysisInput.analysis);
  analysis.facts = [];
  const demand = analysis.demands[0]!;
  demand.explicitRequest.sources = [source];
  demand.approach.sources = [source];
  demand.stage.sources = [source];
  return analysis;
}
export function plannerWork(): PreparedWork {
  return {
    workId: 'work-1',
    leaseToken: 'lease-1',
    expiresAt: '2026-10-29T10:00:00Z',
    snapshotVersion: 1,
    contextVersion: 0,
    customerId: 'customer-1',
    markdown: '',
    catalogVersion: 'catalog-1',
    coverage: { complete: true, missingReasons: [], pagesRead: 1 },
    snapshot: {
      catalog: structuredClone(plannerCatalog),
      candidates: {
        customerId: 'customer-1',
        candidates: [
          {
            ref: { kind: 'organization', id: 11 },
            name: 'Synthetic Organization',
            organizationIds: [],
            sourceRefs: [],
          },
        ],
        coverage: { complete: true, missingReasons: [], pagesRead: 1 },
      },
      conversations: [
        {
          conversationId: 101,
          revision: 'message-r1',
          contact: null,
          messages: [{ id: 201, createdAt: 1793142000, direction: 'outgoing', senderType: 'user' }],
          attachments: [],
          coverage: { complete: true, missingReasons: [], pagesRead: 1 },
        },
      ],
      records: [],
      deals: [],
    },
  };
}
export const plannerResolution: ResolutionBundle = {
  customer: {
    kind: 'resolved',
    customerId: 'customer-1',
    ref: { kind: 'organization', id: 11 },
    sourceRefs: [source],
    reviewReasons: [],
  },
  demands: {
    demands: [
      { kind: 'create', clientKey: 'request-a', demandId: 'demand-a', sourceRefs: [source], reviewReasons: [] },
    ],
    reviewReasons: [],
  },
};
