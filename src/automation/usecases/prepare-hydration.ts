import { createCatalogSnapshot } from '../../agendor/crm/catalog';
import type { AgendorCrmClient, ConfigurationInput } from '../../agendor/crm/types';
import { TENANT_ACCOUNT_KEY } from '../../app/config/tenant';
import { uniqueSources } from '../../domain/identity';
import { SafeError } from '../../shared/errors';
import { hydrateRecord } from '../hydration';
import { preparedWorkSchema } from '../schemas';
import type { WorkflowState } from '../service-state';
import type { PrepareResult, SourceRef } from '../types';
import { persistWorkflow, type WorkflowContext } from './context';

export async function readCatalogAndHydrateStep(
  ctx: WorkflowContext,
  state: WorkflowState,
  crm: AgendorCrmClient,
  snapshotVersion: number,
  validateScope: () => Promise<void>,
): Promise<PrepareResult | undefined> {
  const policy = await ctx.policy();
  const sections: ConfigurationInput[] = [
    { section: 'funnels' },
    { section: 'users' },
    { section: 'products' },
    ...(['organizations', 'people', 'deals'] as const).map((entityType) => ({
      section: 'customFields' as const,
      entityType,
    })),
    ...[...new Set(Object.values(policy.funnelMapping))]
      .filter((id): id is number => id !== undefined)
      .map((funnelId) => ({ section: 'stages' as const, funnelId })),
  ];
  let catalogReads = 0;
  while (state.step - 2 < sections.length) {
    if (catalogReads >= policy.limits.maxRequests) {
      const coverage = {
        complete: false,
        missingReasons: ['catalog_preparation_pending'],
        pagesRead: state.pages.length,
      };
      return {
        state: 'continue',
        workId: state.lease.workId,
        leaseToken: state.lease.leaseToken,
        continuation: state.continuation,
        coverage,
        manifest: {
          workId: state.lease.workId,
          snapshotVersion,
          contextVersion: 0,
          catalogVersion: 'preparing',
          readAt: new Date().toISOString(),
          sources: [],
          messages: [],
          records: [],
          coverage,
        },
      };
    }
    await validateScope();
    state.pages.push(await crm.getConfiguration(sections[state.step - 2]!));
    state.step++;
    await persistWorkflow(ctx.repository, state);
    catalogReads++;
  }
  state.catalog = createCatalogSnapshot({ accountId: TENANT_ACCOUNT_KEY, pages: state.pages });
  await validateScope();
  const retained = await ctx.repository.getPreparationBasis(state.customerId);
  state.hydration ??= { offset: 0, records: [], deals: [], sources: [], missingReasons: [] };
  const hydration = state.hydration;
  const targets = [
    ...state.candidates.candidates.map((c) => ({ ref: c.ref, demand: undefined })),
    ...retained.demands.flatMap((d) => (d.dealRef ? [{ ref: d.dealRef, demand: d }] : [])),
  ].slice(0, 100);
  if (
    retained.demands.length > 100 ||
    retained.commands.length > 500 ||
    state.candidates.candidates.length + retained.demands.filter((d) => d.dealRef).length > 100
  )
    hydration.missingReasons.push('crm_hydration_limit');
  while (hydration.offset < targets.length) {
    if (catalogReads >= policy.limits.maxRequests) {
      const coverage = {
        complete: false,
        missingReasons: ['crm_preparation_pending'],
        pagesRead: hydration.offset,
      };
      await persistWorkflow(ctx.repository, state);
      return {
        state: 'continue',
        workId: state.lease.workId,
        leaseToken: state.lease.leaseToken,
        continuation: state.continuation,
        coverage,
        manifest: {
          workId: state.lease.workId,
          snapshotVersion,
          contextVersion: 0,
          catalogVersion: state.catalog.version,
          readAt: new Date().toISOString(),
          sources: [],
          messages: [],
          records: [],
          coverage,
        },
      };
    }
    const target = targets[hydration.offset]!;
    await validateScope();
    try {
      const raw =
        target.ref.kind === 'person'
          ? await crm.getPerson(target.ref.id)
          : target.ref.kind === 'organization'
            ? await crm.getOrganization(target.ref.id)
            : await crm.getDeal(target.ref.id);
      const result = await hydrateRecord(raw, target.ref, state.catalog, policy, retained.commands, target.demand);
      hydration.records.push(result.record);
      hydration.sources.push(result.source);
      if (result.deal) hydration.deals.push(result.deal);
      const candidate = state.candidates.candidates.find(
        (c) => c.ref.kind === target.ref.kind && c.ref.id === target.ref.id,
      );
      if (candidate) {
        candidate.sourceRefs = [result.source];
        candidate.name = String(result.record.fields.find((f) => f.field === 'name')!.value);
        const email = result.record.fields.find((f) => f.field === 'email')?.value;
        const phone = result.record.fields.find((f) => f.field === 'phone')?.value;
        const document = result.record.fields.find((f) => f.field === 'cnpj')?.value;
        if (typeof email === 'string') candidate.email = email;
        else delete candidate.email;
        if (typeof phone === 'string') candidate.phone = phone;
        else delete candidate.phone;
        if (typeof document === 'string') candidate.document = document;
        else delete candidate.document;
        const organization = raw && typeof raw === 'object' && 'organization' in raw ? raw.organization : undefined;
        const organizationId =
          typeof organization === 'number'
            ? organization
            : organization && typeof organization === 'object' && 'id' in organization
              ? organization.id
              : undefined;
        candidate.organizationIds =
          typeof organizationId === 'number' && Number.isSafeInteger(organizationId) && organizationId > 0
            ? [organizationId]
            : [];
        for (const link of state.candidates.verifiedLinks ?? [])
          if (link.ref.kind === target.ref.kind && link.ref.id === target.ref.id)
            link.sourceRefs = [...link.sourceRefs.filter((s) => s.kind !== 'crm'), result.source];
      }
    } catch (error) {
      if (error instanceof SafeError && error.retryable) throw error;
      hydration.missingReasons.push('crm_record_unverified');
    }
    hydration.offset++;
    catalogReads++;
    await persistWorkflow(ctx.repository, state);
  }
  return undefined;
}

export async function finalizePreparedSnapshot(
  ctx: WorkflowContext,
  state: WorkflowState,
  snapshotVersion: number,
  validateScope: () => Promise<void>,
): Promise<PrepareResult> {
  const hydration = state.hydration!;
  const sources: SourceRef[] = uniqueSources([
    ...state.conversations.flatMap((c) => [
      ...c.messages.map((m) => ({
        kind: 'message' as const,
        id: `${c.conversationId}:${m.id}`,
        revision: c.revision,
      })),
      ...(c.contact ? [{ kind: 'contact' as const, id: String(c.contact.id), revision: c.revision }] : []),
    ]),
    ...state.candidates.candidates.flatMap((c) => c.sourceRefs),
    ...(state.candidates.verifiedLinks ?? []).flatMap((c) => c.sourceRefs),
    ...hydration.sources,
  ]);
  await validateScope();
  let markdown = '';
  let contextVersion = 0;
  const context = await ctx.repository.findContext(state.customerId);
  if (context) {
    markdown = context.markdown;
    contextVersion = context.version;
  }
  const reasons = [
    ...new Set([
      ...state.conversations.flatMap((c) => c.coverage.missingReasons),
      ...state.candidates.coverage.missingReasons,
      ...hydration.missingReasons,
      ...state.conversations.flatMap((c) => (c.attachments.length ? ['attachments_not_read'] : [])),
    ]),
  ];
  const coverage = {
    complete:
      reasons.length === 0 &&
      state.conversations.every((c) => c.coverage.complete) &&
      state.candidates.coverage.complete,
    missingReasons: reasons,
    pagesRead: state.conversations.reduce((n, c) => n + c.coverage.pagesRead, 0) + state.candidates.coverage.pagesRead,
  };
  state.work = preparedWorkSchema.parse({
    workId: state.lease.workId,
    leaseToken: state.lease.leaseToken,
    expiresAt: state.lease.expiresAt,
    snapshotVersion,
    contextVersion,
    customerId: state.customerId,
    markdown,
    snapshot: {
      conversations: state.conversations,
      candidates: state.candidates,
      catalog: state.catalog,
      sourceRefs: sources,
      records: hydration.records,
      deals: hydration.deals,
    },
    catalogVersion: state.catalog!.version,
    coverage,
    ...(state.pendingReview
      ? {
          reviewDecision: {
            reviewId: state.pendingReview.reviewId,
            version: state.pendingReview.version,
            decision: state.pendingReview.decision,
          },
        }
      : {}),
  });
  state.basis = {
    lease: state.lease,
    customerId: state.customerId,
    snapshotVersion,
    contextVersion,
    catalogVersion: state.catalog!.version,
  };
  await validateScope();
  state.revision++;
  await ctx.repository.installSnapshot(
    state.lease,
    {
      workId: state.lease.workId,
      snapshotVersion,
      contextVersion,
      catalogVersion: state.catalog!.version,
      readAt: new Date().toISOString(),
      sources,
      messages: state.conversations.flatMap((c) =>
        c.messages.map((m) => ({
          conversationId: c.conversationId,
          id: m.id,
          revision: c.revision,
          hash: c.revision,
          direction: m.direction ?? 'unknown',
          ...(m.senderType ? { senderType: m.senderType } : {}),
          ...(m.senderId ? { senderId: m.senderId } : {}),
        })),
      ),
      records: [
        ...state.candidates.candidates.map((c) => ({
          ref: c.ref,
          revision: c.sourceRefs.find((s) => s.kind === 'crm')!.revision,
          hash: c.sourceRefs.find((s) => s.kind === 'crm')!.revision,
        })),
        ...hydration.deals.map((d) => ({ ref: d.ref, revision: d.revision, hash: d.revision })),
      ],
      coverage,
    },
    state,
  );
  return { state: 'ready', work: state.work };
}
