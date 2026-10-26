import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCapabilities, type AuthContext } from '../src/auth';
import { authorizePlan, authorizeSubmission, requireAutomationOperation, requirePolicyCapabilities } from '../src/automation/authorization';
import type { AutomationPolicy, Capability, MutationCommand, WorkLease } from '../src/automation/types';
import { validAnalysisInput, validPlan } from './fixtures/automation';
import { consentPage } from '../src/oauth/consent';
import { oauthToolSecurity } from '../src/mcp/security';

const now = 1_793_016_000_000;
const expiresAt = 1_793_016_060_000;
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(now); });
const all: Capability[] = ['crm:read', 'chat:read', 'crm:write', 'crm:create', 'crm:enrich', 'automation:read', 'automation:process', 'automation:manage'];
function auth(scopes: readonly string[] = all): AuthContext { return { userId: 'owner-1', clientId: 'client-1', scopes, expiresAt }; }
const policy: AutomationPolicy = { version: 1, mode: 'apply', allowedInboxIds: [], capabilities: all, funnelMapping: {}, stageMapping: [], customFieldMapping: [], nativeCreatorDisabled: true, limits: { maxConversations: 10, maxCommands: 10, maxRequests: 20 } };
const lease: WorkLease = { workId: 'work-1', leaseToken: 'lease-1', owner: { userId: 'owner-1', clientId: 'client-1' }, fence: 1, expiresAt: '2026-10-26T12:01:00.000Z', mode: 'preview', target: { kind: 'conversation', conversationId: 101 } };

// Catch accidental scope inheritance and missing product-read gates.
describe('exact capability matrix', () => {
  it('crm:write legado não concede criação', () => {
    expect(() => requireCapabilities(auth(['crm:write']), ['crm:create'])).toThrow();
  });
  it.each(all.filter(capability => capability !== 'crm:write'))('legacy writes do not imply %s', capability => {
    expect(() => requireCapabilities(auth(['crm:write']), [capability])).toThrow();
  });
  it('requires every capability, preserves exact missing-scope errors', () => {
    expect(() => requireCapabilities(auth(['automation:process', 'chat:read']), ['automation:process', 'chat:read', 'crm:read'])).toThrowError(expect.objectContaining({ status: 403, requiredScope: 'crm:read' }));
    expect(() => requireCapabilities(auth(['crm:create']), ['crm:create'])).not.toThrow();
  });
  it.each([
    ['prepare', ['automation:process', 'chat:read', 'crm:read']],
    ['submit', ['automation:process', 'chat:read', 'crm:read']],
    ['apply', ['automation:process']],
    ['operation', ['automation:read']],
    ['context', ['automation:read', 'chat:read', 'crm:read']],
    ['reviews', ['automation:read', 'chat:read', 'crm:read']],
    ['resolveReview', ['automation:manage', 'chat:read', 'crm:read']],
    ['status', ['automation:read']],
    ['updatePolicy', ['automation:manage']],
    ['reprocess', ['automation:manage', 'chat:read', 'crm:read']],
  ] as const)('%s requires exactly its product and workflow capabilities', (operation, scopes) => {
    expect(() => requireAutomationOperation(auth(scopes), operation)).not.toThrow();
    for (const missing of scopes) expect(() => requireAutomationOperation(auth(scopes.filter(s => s !== missing)), operation)).toThrowError(expect.objectContaining({ requiredScope: missing }));
  });
  it('automation:process alone cannot read context or prepare mixed-product snapshots', () => {
    expect(() => requireAutomationOperation(auth(['automation:process']), 'context')).toThrow();
    expect(() => requireAutomationOperation(auth(['automation:process']), 'prepare')).toThrow();
  });
  it.each(['crm:read', 'chat:read', 'crm:write', 'crm:create', 'crm:enrich'] as const)('automation:process does not grant %s', capability => {
    expect(() => requireCapabilities(auth(['automation:process']), [capability])).toThrowError(expect.objectContaining({ requiredScope: capability }));
  });
  it('management must also hold any CRM capabilities enabled by policy', () => {
    expect(() => requirePolicyCapabilities(auth(['automation:manage']), policy)).toThrow();
    expect(() => requirePolicyCapabilities(auth(), policy)).not.toThrow();
  });
});

const commands: MutationCommand[] = [
  validPlan.orderedCommands[0]!,
  { kind: 'create_person', payload: { name: 'Synthetic' } },
  { kind: 'create_deal', target: { kind: 'person', id: 1 }, payload: { title: 'Synthetic' } },
  { kind: 'create_task', target: { kind: 'person', id: 1 }, payload: { text: 'Synthetic', type: 1, assigned_users: [1], due_date: '2026-10-27T00:00:00Z' } },
  { kind: 'enrich_organization', target: { kind: 'organization', id: 1 }, patch: { name: 'Synthetic' } },
  { kind: 'enrich_person', target: { kind: 'person', id: 1 }, patch: { name: 'Synthetic' } },
  { kind: 'enrich_deal', target: { kind: 'deal', id: 1 }, patch: { title: 'Synthetic' } },
  { kind: 'update_task', target: { kind: 'task', id: 1 }, patch: { text: 'Synthetic' } },
  { kind: 'change_stage', target: { kind: 'deal', id: 1 }, patch: { funnel: 1, dealStage: 1 } },
].map((command, i) => ({ ...command, commandKey: `command-${i}`, dependencies: [], before: [], sourceRefs: validPlan.sourceRefs, requiredCapabilities: ['crm:read'] } as MutationCommand));

describe('plan authorization', () => {
  it.each(commands.map((command, index) => [command, index < 4 ? 'crm:create' : index < 8 ? 'crm:enrich' : 'crm:write'] as const))('derives authorization for $kind despite forged declared capabilities', (command, capability) => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const plan = { ...validPlan, orderedCommands: [command] };
    expect(() => authorizePlan(auth(['automation:process', 'crm:read']), plan, policy)).toThrowError(expect.objectContaining({ requiredScope: capability }));
    const authorized = authorizePlan(auth(['automation:process', capability]), plan, policy);
    expect(authorized.commandCapabilities).toEqual([{ commandKey: command.commandKey, capabilities: [capability] }]);
    expect(authorized.plan.orderedCommands[0]!.requiredCapabilities).toEqual([capability]);
  });
  it('management alone never applies a plan', () => {
    expect(() => authorizePlan(auth(['automation:manage']), validPlan, policy)).toThrow();
  });
  it('captures only copied identity, scopes and exact expiration without a bearer token', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const caller = { ...auth(), scopes: [...all], accessToken: 'synthetic-do-not-store' };
    const plan = structuredClone(validPlan);
    const authorized = authorizePlan(caller, plan, policy);
    expect(authorized.validUntil).toBe('2026-10-26T12:01:00.000Z');
    expect(authorized.actor).toEqual({ userId: 'owner-1', clientId: 'client-1', scopes: all, expiresAt });
    expect(JSON.stringify(authorized)).not.toContain('synthetic-do-not-store');
    caller.scopes.length = 0;
    plan.orderedCommands[0]!.requiredCapabilities.push('crm:write');
    expect(authorized.plan.orderedCommands[0]!.requiredCapabilities).toEqual(['crm:create']);
    expect(authorized.actor.scopes).toEqual(all);
  });
  it.each([undefined, now - 1, now, NaN, Infinity])('requires a finite, future authorization expiry %s', expiry => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(() => authorizePlan({ ...auth(), expiresAt: expiry }, validPlan, policy)).toThrow();
  });
  it.each(['disabled', 'preview'] as const)('rejects policy mode %s', mode => {
    expect(() => authorizePlan(auth(), validPlan, { ...policy, mode })).toThrow();
  });
  it('rejects stale policy, unresolved reviews and missing identity', () => {
    expect(() => authorizePlan(auth(), validPlan, { ...policy, version: 2 })).toThrow();
    expect(() => authorizePlan(auth(), { ...validPlan, state: 'review' }, policy)).toThrow();
    expect(() => authorizePlan({ ...auth(), userId: undefined }, validPlan, policy)).toThrow();
  });
  it('checks the command capability against policy as well as caller scopes', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(() => authorizePlan(auth(), validPlan, { ...policy, capabilities: ['automation:process', 'crm:read'] })).toThrow();
  });
  it('operator evidence cannot bypass a command permission', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const plan = structuredClone(validPlan);
    plan.orderedCommands[0]!.sourceRefs = [{ kind: 'operator', id: 'synthetic-review', revision: '1' }];
    expect(() => authorizePlan(auth(['automation:process']), plan, policy)).toThrowError(expect.objectContaining({ requiredScope: 'crm:create' }));
  });
});

describe('submission ownership', () => {
  it('accepts the current caller-owned work', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(() => authorizeSubmission(auth(), validAnalysisInput, lease)).not.toThrow();
  });
  it.each(['userId', 'clientId'] as const)('rejects a different lease %s', key => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(() => authorizeSubmission({ ...auth(), [key]: 'other' }, validAnalysisInput, lease)).toThrow();
  });
  it.each([
    { workId: 'other' }, { leaseToken: 'other' },
  ])('rejects mismatched submission claims %j', patch => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(() => authorizeSubmission(auth(), { ...validAnalysisInput, ...patch }, lease)).toThrow();
  });
  it('rejects expired leases and expired caller authorization', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(() => authorizeSubmission(auth(), validAnalysisInput, { ...lease, expiresAt: '2026-10-26T12:00:00.000Z' })).toThrow();
    expect(() => authorizeSubmission({ ...auth(), expiresAt: now }, validAnalysisInput, lease)).toThrow();
    expect(() => authorizeSubmission({ ...auth(), expiresAt: undefined }, validAnalysisInput, lease)).not.toThrow();
  });
});

it('explains all new consent capabilities without broad generic access language', () => {
  const page = consentPage({ scope: all, clientName: 'Synthetic client', redirectHost: 'example.test' } as Parameters<typeof consentPage>[0], 'synthetic-handle');
  expect(page).toContain('criar');
  expect(page).toContain('enriquecer');
  expect(page).toContain('processar');
  expect(page).toContain('gerenciar');
  expect(page).not.toContain('acessar o Agendor');
  expect(oauthToolSecurity('automation:process', 'chat:read', 'crm:read')).toEqual({ securitySchemes: [{ type: 'oauth2', scopes: ['automation:process', 'chat:read', 'crm:read'] }] });
});
