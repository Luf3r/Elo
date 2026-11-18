import type { PageInfo } from '../../src/agendor/crm/types';
import type { AuthContext } from '../../src/auth';
import type {
  Actor,
  AgentAnalysis,
  AnalysisInput,
  AutomationPolicy,
  Capability,
  ContextProjection,
  Coverage,
  CustomerCandidate,
  CustomerCandidates,
  DemandRecord,
  Fact,
  MutationCommand,
  PlanBasis,
  PreparedWork,
  ReserveWorkInput,
  SnapshotManifest,
  SourceRef,
  SyncPlan,
  WorkLease,
} from '../../src/automation/types';
import { catalogFixture } from './automation';

export type SubmissionSourceRef = Omit<SourceRef, 'kind'> & { kind: 'message' | 'contact' | 'crm' };
export type SubmissionFact = AgentAnalysis['facts'][number];

export const ALL_CAPABILITIES: readonly Capability[] = [
  'crm:read',
  'chat:read',
  'crm:write',
  'crm:create',
  'crm:enrich',
  'automation:read',
  'automation:process',
  'automation:manage',
];

const DEFAULT_SOURCE: SubmissionSourceRef = { kind: 'message', id: '101:201', revision: 'message-rev-1' };

/** Build a synthetic submission-safe source reference for tests. */
export function buildSourceRef(overrides: Partial<SubmissionSourceRef> = {}): SubmissionSourceRef {
  return { ...DEFAULT_SOURCE, ...overrides };
}

/** Build an authenticated caller context compatible with both `AuthContext` and `Actor`. */
export function buildActor(
  overrides: Partial<AuthContext> = {},
): Actor & { userId: string; scopes: string[]; expiresAt: number } {
  return {
    userId: overrides.userId ?? 'operator-1',
    clientId: overrides.clientId ?? 'client-1',
    scopes: [...(overrides.scopes ?? ALL_CAPABILITIES)],
    expiresAt: overrides.expiresAt ?? Date.now() + 600_000,
  };
}

/** Build a complete coverage record by default. */
export function buildCoverage(): { complete: boolean; missingReasons: never[]; pagesRead: number };
export function buildCoverage(overrides: Partial<Coverage>): Coverage;
export function buildCoverage(overrides: Partial<Coverage> = {}): Coverage {
  return {
    complete: true,
    missingReasons: [],
    pagesRead: 1,
    ...overrides,
  };
}

/** Build a CRM pagination metadata object. */
export function buildPageInfo(overrides: Partial<PageInfo> = {}): PageInfo {
  return {
    page: 1,
    perPage: 100,
    hasNext: false,
    nextPage: null,
    ...overrides,
  };
}

/** Build an automation policy with synthetic defaults. */
export function buildPolicy(overrides: Partial<AutomationPolicy> = {}): AutomationPolicy {
  return {
    version: 1,
    mode: 'apply',
    allowedInboxIds: [],
    capabilities: [...ALL_CAPABILITIES],
    funnelMapping: {},
    stageMapping: [],
    customFieldMapping: [],
    nativeCreatorDisabled: true,
    limits: { maxConversations: 10, maxCommands: 10, maxRequests: 20 },
    ...overrides,
  };
}

/** Build a work lease for Durable Object and authorization tests. */
export function buildWorkLease(overrides: Partial<WorkLease> = {}): WorkLease {
  return {
    workId: 'work-1',
    leaseToken: 'lease-1',
    owner: { userId: 'operator-1', clientId: 'client-1' },
    fence: 1,
    expiresAt: '2026-10-26T12:01:00.000Z',
    mode: 'preview',
    target: { kind: 'conversation', conversationId: 101 },
    ...overrides,
  };
}

/** Build a `ReserveWorkInput` payload for DO reservation tests. */
export function buildReserveWorkInput(overrides: Partial<ReserveWorkInput> = {}): ReserveWorkInput {
  return {
    requestId: 'request-1',
    target: { kind: 'conversation', conversationId: 101 },
    mode: 'apply',
    actor: { userId: 'operator-1', clientId: 'client-1', scopes: ['automation:process'] },
    payloadDigest: 'digest-1',
    ...overrides,
  };
}

/** Build a snapshot manifest referencing synthetic sources. */
export function buildSnapshotManifest(overrides: Partial<SnapshotManifest> = {}): SnapshotManifest {
  return {
    workId: 'work-1',
    snapshotVersion: 1,
    contextVersion: 0,
    catalogVersion: 'catalog-1',
    readAt: '2026-10-26T12:00:00.000Z',
    sources: [buildSourceRef()],
    messages: [],
    records: [],
    coverage: buildCoverage(),
    ...overrides,
  };
}

/** Build a `PlanBasis` bound to the given lease. */
export function buildPlanBasis(lease: WorkLease, overrides: Partial<Omit<PlanBasis, 'lease'>> = {}): PlanBasis {
  return {
    lease,
    customerId: 'customer-1',
    snapshotVersion: 1,
    contextVersion: 0,
    catalogVersion: 'catalog-1',
    ...overrides,
  };
}

/** Build a submission-safe sourced fact entry. */
export function buildFact(overrides: Partial<SubmissionFact> = {}): SubmissionFact {
  return {
    entity: 'organization',
    field: 'name',
    value: 'Synthetic Organization',
    certainty: 'confirmed',
    sources: [buildSourceRef()],
    ...overrides,
  };
}

/** Build an internal fact entry (including operator-sourced facts). */
export function buildInternalFact(overrides: Partial<Fact> = {}): Fact {
  return {
    entity: 'organization',
    field: 'name',
    value: 'Synthetic Organization',
    certainty: 'confirmed',
    sources: [buildSourceRef()],
    ...overrides,
  };
}

/** Build a single demand item inside an `AgentAnalysis`. */
export function buildDemand(
  overrides: Partial<AgentAnalysis['demands'][number]> = {},
): AgentAnalysis['demands'][number] {
  const source = buildSourceRef();
  return {
    clientKey: 'request-a',
    service: 'Synthetic analysis',
    scope: 'Synthetic scope',
    explicitRequest: { value: true, sources: [source] },
    approach: { value: 'client', sources: [source] },
    stage: { value: 'new_request', sources: [source] },
    items: [],
    commitments: [],
    ...overrides,
  };
}

/** Build an `AgentAnalysis` object with synthetic defaults. */
export function buildAnalysis(overrides: Partial<AgentAnalysis> = {}): AgentAnalysis {
  return {
    customerSelection: { kind: 'organization', id: 11 },
    facts: [buildFact()],
    demands: [buildDemand()],
    ambiguities: [],
    ...overrides,
  };
}

/** Build an `AnalysisInput` submission wrapper. */
export function buildAnalysisInput(overrides: Partial<AnalysisInput> = {}): AnalysisInput {
  return {
    workId: 'work-1',
    leaseToken: 'lease-1',
    expectedSnapshotVersion: 1,
    expectedContextVersion: 0,
    analysis: buildAnalysis(),
    ...overrides,
  };
}

/** Build a `create_organization` mutation command. */
export function buildCreateOrganizationCommand(
  overrides: Partial<Extract<MutationCommand, { kind: 'create_organization' }>> = {},
): Extract<MutationCommand, { kind: 'create_organization' }> {
  return {
    kind: 'create_organization',
    commandKey: 'company-create',
    payload: { name: 'Synthetic Organization' },
    dependencies: [],
    before: [],
    sourceRefs: [buildSourceRef()],
    requiredCapabilities: ['crm:create'],
    ...overrides,
  };
}

/** Build a `SyncPlan` with synthetic defaults. */
export function buildSyncPlan(overrides: Partial<SyncPlan> = {}): SyncPlan {
  return {
    planId: 'plan-1',
    version: 1,
    policyVersion: 1,
    workId: 'work-1',
    analysisRevision: 1,
    orderedCommands: [buildCreateOrganizationCommand()],
    before: [],
    after: [],
    sourceRefs: [buildSourceRef()],
    reviewIds: [],
    state: 'ready',
    ...overrides,
  };
}

/** Build a CRM customer candidate for identity resolution tests. */
export function buildCandidate(id = 11, overrides: Partial<CustomerCandidate> = {}): CustomerCandidate {
  return {
    ref: { kind: 'organization', id },
    name: 'Synthetic Organization',
    organizationIds: [],
    sourceRefs: [{ kind: 'crm', id: `organization:${id}`, revision: 'r1' }],
    ...overrides,
  };
}

/** Build a `CustomerCandidates` collection wrapper. */
export function buildCandidates(
  items: CustomerCandidate[] = [],
  overrides: Partial<CustomerCandidates> = {},
): CustomerCandidates {
  return {
    candidates: items,
    coverage: buildCoverage({ pagesRead: 2 }),
    ...overrides,
  };
}

/** Build a persisted `DemandRecord` fixture. */
export function buildDemandRecord(overrides: Partial<DemandRecord> = {}): DemandRecord {
  return {
    demandId: 'permanent-demand',
    customerId: 'backend-customer',
    clientKey: 'prior-key',
    service: 'Synthetic analysis',
    scope: 'Synthetic scope',
    state: 'open',
    sourceRefs: [buildSourceRef()],
    ...overrides,
  };
}

/** Build a `ContextProjection` for rendering and persistence tests. */
export function buildContextProjection(overrides: Partial<ContextProjection> = {}): ContextProjection {
  return {
    customerId: 'customer-1',
    version: 1,
    verifiedAt: '2026-10-26T12:00:00Z',
    facts: [],
    contacts: [],
    demands: [],
    receipts: [],
    pendingReasons: [],
    ...overrides,
  };
}

/** Build a `PreparedWork` snapshot bundle for pure planner/domain tests. */
export function buildPreparedWork(overrides: Partial<PreparedWork> = {}): PreparedWork {
  return {
    workId: 'work-1',
    leaseToken: 'lease-1',
    expiresAt: '2026-10-29T10:00:00Z',
    snapshotVersion: 1,
    contextVersion: 0,
    customerId: 'customer-1',
    markdown: '',
    catalogVersion: 'catalog-1',
    coverage: buildCoverage(),
    snapshot: {
      catalog: structuredClone(catalogFixture),
      candidates: buildCandidates([buildCandidate(11, { sourceRefs: [] })], {
        customerId: 'customer-1',
        coverage: buildCoverage(),
      }),
      conversations: [
        {
          conversationId: 101,
          revision: 'message-r1',
          contact: null,
          messages: [{ id: 201, createdAt: 1793142000, direction: 'outgoing', senderType: 'user' }],
          attachments: [],
          coverage: buildCoverage(),
        },
      ],
      records: [],
      deals: [],
    },
    ...overrides,
  };
}
