import { afterEach, expect, it, vi } from 'vitest';
import * as chat from '../src/automation/clients';
import * as crm from '../src/automation/clients';
import { createAutomationService } from '../src/automation/service';
import { budgetMock, testEnv } from './helpers';
import type { AgentAnalysis, PrepareInput } from '../src/automation/types';
import {
  buildActor,
  buildAnalysis,
  buildCoverage,
  buildDemand,
  buildFact,
  buildPageInfo,
  buildSourceRef,
} from './fixtures/builders';

afterEach(() => {
  vi.restoreAllMocks();
});

async function fixture() {
  const runtime = testEnv({ AGENDOR_CHAT_TOKEN: 'synthetic', AGENDOR_CHAT_ACCOUNT_ID: '123' });
  budgetMock(runtime).mockResolvedValue({ allowed: true, reservationId: 'test' });
  const actor = buildActor({
    userId: 'review-owner',
    clientId: 'review-client',
    scopes: ['automation:process', 'automation:manage', 'automation:read', 'crm:read', 'chat:read', 'crm:create'],
  });
  const chatClient = chat.createAgendorChatClient(runtime);
  const crmClient = crm.createAgendorCrmClient(runtime);
  let message = 'Synthetic identity question';
  const complete = buildCoverage();

  vi.spyOn(chat, 'createAgendorChatClient').mockReturnValue({
    ...chatClient,
    getContact: async (id) => ({ contact: { id, name: 'Synthetic Customer' }, coverage: complete }),
    getConversation: async (id) => ({
      id,
      inboxId: 4101,
      contact: { id: 2, name: 'Synthetic Customer' },
      coverage: complete,
    }),
    listMessages: async (id) => ({
      conversationId: id,
      messages: [
        { id: 201, conversationId: id, content: message, direction: 'incoming', senderType: 'contact', senderId: 2 },
      ],
      coverage: complete,
    }),
    listAttachments: async () => ({ attachments: [], coverage: complete }),
  });

  const pageInfo = buildPageInfo();
  vi.spyOn(crm, 'createAgendorCrmClient').mockReturnValue({
    ...crmClient,
    searchPeople: async () => ({ items: [], pageInfo }),
    searchOrganizations: async () => ({ items: [{ id: 11, name: 'Synthetic Customer' }], pageInfo }),
    getOrganization: async (id) => ({ id, name: 'Synthetic Customer' }),
    getConfiguration: async (input) => ({
      ...input,
      items: [],
      pageInfo,
      fetchedAt: new Date().toISOString(),
      coverage: { status: 'complete', pages: [1] },
    }),
  });

  const service = createAutomationService(runtime, actor);
  await service.updatePolicy({ expectedVersion: 1, patch: { mode: 'preview', capabilities: ['crm:create'] } });
  const input: PrepareInput = {
    requestId: 'reviewed-request',
    target: { kind: 'conversation', conversationId: 101 },
    mode: 'preview',
  };
  const first = await service.prepare(input);
  if (first.state !== 'ready') throw Error('fixture preparation failed');

  const analysis: AgentAnalysis = buildAnalysis({ facts: [], demands: [] });
  const submission = (work: typeof first.work, value = analysis) => ({
    workId: work.workId,
    leaseToken: work.leaseToken,
    expectedSnapshotVersion: work.snapshotVersion,
    expectedContextVersion: work.contextVersion,
    analysis: value,
  });

  return {
    runtime,
    service,
    actor,
    input,
    first,
    analysis,
    submission,
    changeMessage: () => {
      message = 'Canonical content changed';
    },
  };
}

it('consumes a customer review in the next fresh snapshot and plan instead of repeating the ambiguity', async () => {
  const f = await fixture();
  const original = await f.service.submit(f.submission(f.first.work));
  expect(original.state).toBe('review');

  const review = (await f.service.listReviews({})).reviews[0]!;
  await f.service.resolveReview({
    reviewId: review.reviewId,
    expectedVersion: review.version,
    decision: { kind: 'selectCustomer', ref: { kind: 'organization', id: 11 } },
  });

  const next = await f.service.prepare(f.input);
  expect(next.state).toBe('ready');
  if (next.state !== 'ready') return;
  expect(next.work.snapshotVersion).toBe(2);
  expect(next.work).toMatchObject({
    reviewDecision: {
      reviewId: review.reviewId,
      version: 2,
      decision: { kind: 'selectCustomer', ref: { kind: 'organization', id: 11 } },
    },
  });

  const fresh = await f.service.submit(f.submission(next.work));
  expect(fresh.planId).not.toBe(original.planId);
  expect(fresh.state).toBe('noop');
  expect(fresh.reviewIds).toEqual([]);

  const audit = await f.service.getAudit({ limit: 100 });
  expect(audit.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ action: 'review_consumed', targetId: review.reviewId, version: 3 }),
    ]),
  );

  const another = await f.service.prepare({
    requestId: 'different-order',
    target: { kind: 'conversation', conversationId: 102 },
    mode: 'preview',
  });
  if (another.state !== 'ready') throw Error('next preparation failed');
  expect((await f.service.submit(f.submission(another.work))).state).toBe('review');
});

it('applies a sourced fact correction to one reviewed analysis and creates a fresh command', async () => {
  const f = await fixture();
  const source = f.first.work.snapshot.sourceRefs!.find((s) => s.kind === 'message')!;
  f.analysis.customerSelection = { kind: 'new', entity: 'organization', record: { name: 'Wrong proposed name' } };
  f.analysis.facts = [
    buildFact({
      value: 'Wrong proposed name',
      certainty: 'ambiguous',
      sources: [{ ...source, kind: 'message' }],
    }),
  ];

  const original = await f.service.submit(f.submission(f.first.work));
  expect(original.state).toBe('review');

  const review = (await f.service.listReviews({})).reviews[0]!;
  await f.service.resolveReview({
    reviewId: review.reviewId,
    expectedVersion: 1,
    decision: {
      kind: 'correctFacts',
      facts: [buildFact({ value: 'Corrected Company', sources: [{ ...source, kind: 'message' }] })],
    },
  });

  const next = await f.service.prepare(f.input);
  if (next.state !== 'ready') throw Error('next preparation failed');
  const fresh = await f.service.submit(f.submission(next.work));
  expect(fresh.state).toBe('ready');
  expect(fresh.orderedCommands).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'create_organization', payload: { name: 'Corrected Company' } }),
    ]),
  );
});

it('does not carry a reviewed decision to changed canonical sources or another actor', async () => {
  const f = await fixture();
  await f.service.submit(f.submission(f.first.work));
  const review = (await f.service.listReviews({})).reviews[0]!;
  await f.service.resolveReview({
    reviewId: review.reviewId,
    expectedVersion: 1,
    decision: { kind: 'selectCustomer', ref: { kind: 'organization', id: 11 } },
  });

  f.changeMessage();
  const next = await f.service.prepare(f.input);
  if (next.state !== 'ready') throw Error('next preparation failed');
  await expect(f.service.submit(f.submission(next.work))).rejects.toThrow('REVIEW_SOURCE_CHANGED');
  await expect(
    createAutomationService(f.runtime, { ...f.actor, clientId: 'foreign-client' }).prepare(f.input),
  ).rejects.toThrow();
});

it('binds approval to its reviewed plan and does not bypass unresolved canonical identity', async () => {
  const f = await fixture();
  const original = await f.service.submit(f.submission(f.first.work));
  const review = (await f.service.listReviews({})).reviews[0]!;
  await f.service.resolveReview({
    reviewId: review.reviewId,
    expectedVersion: 1,
    decision: { kind: 'approvePlan', planId: original.planId, planVersion: original.version },
  });

  const next = await f.service.prepare(f.input);
  if (next.state !== 'ready') throw Error('next preparation failed');

  const snapshotSource = next.work.snapshot.sourceRefs!.find((s) => s.kind === 'message')!;
  const msgSource = buildSourceRef({ ...snapshotSource, kind: 'message' });
  const changed = structuredClone(f.analysis);
  changed.demands = [
    buildDemand({
      clientKey: 'new-order',
      service: 'new',
      scope: 'new',
      explicitRequest: { value: true, sources: [msgSource] },
      approach: { value: 'client', sources: [msgSource] },
      stage: { value: 'new_request', sources: [msgSource] },
    }),
  ];

  await expect(f.service.submit(f.submission(next.work, changed))).rejects.toThrow('REVIEW_ANALYSIS_CHANGED');

  const fresh = await f.service.submit(f.submission(next.work));
  expect(fresh.planId).not.toBe(original.planId);
  expect(fresh.state).toBe('review');
  expect(fresh.orderedCommands).toEqual([]);
  expect((await f.service.getAudit({ limit: 100 })).entries).toEqual(
    expect.arrayContaining([expect.objectContaining({ action: 'review_consumed', targetId: review.reviewId })]),
  );
});
