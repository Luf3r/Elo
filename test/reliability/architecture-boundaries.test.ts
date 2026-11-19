/// <reference types="vite/client" />
import { describe, expect, expectTypeOf, it } from 'vitest';
import { createAgendorChatClient, type ChatClientOptions } from '../../src/agendor/chat/client';
import { createAgendorCrmClient, type CrmClientOptions } from '../../src/agendor/crm/client';
import { createCrmMutationClient, type CrmMutationDependencies } from '../../src/agendor/crm/mutations';
import type { BudgetGate, InboxGuard } from '../../src/agendor/ports';
import * as tenant from '../../src/app/config/tenant';
import { applyReviewDecision } from '../../src/domain/reviews';
import { canonical } from '../../src/shared/canonical';

const srcFiles = import.meta.glob<string>('../../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('architecture and tenant boundaries', () => {
  it('uses every exported constant from src/app/config/tenant.ts inside src/', () => {
    const tenantKey = '../../src/app/config/tenant.ts';
    const tenantSource = srcFiles[tenantKey];
    expect(tenantSource).toBeDefined();

    const exportedNames = [...tenantSource!.matchAll(/export const (\w+)/g)].map((match) => match[1]!);
    expect(exportedNames).toEqual(['TENANT_ACCOUNT_KEY', 'ALLOWED_INBOX_IDS', 'TENANT_SERVICE_NAME']);
    expect(tenant.TENANT_ACCOUNT_KEY).toBe('elotenant');
    expect(tenant.ALLOWED_INBOX_IDS).toEqual([4101, 4102]);
    expect(tenant.TENANT_SERVICE_NAME).toBe('elo-agendor-mcp');

    const otherSrcEntries = Object.entries(srcFiles).filter(([file]) => file !== tenantKey);
    for (const name of exportedNames) {
      const usedIn = otherSrcEntries.filter(([, content]) => new RegExp(`\\b${name}\\b`).test(content));
      expect(usedIn.length, `Expected ${name} to be referenced in src/ outside tenant.ts`).toBeGreaterThan(0);
    }
  });

  it('keeps pure domain modules in src/domain/ without IO or client imports', () => {
    expect(srcFiles['../../src/domain/reviews.ts']).toBeDefined();
    expect(srcFiles['../../src/automation/reviews.ts']).toBeUndefined();
    expect(typeof applyReviewDecision).toBe('function');
    expect(canonical({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');

    const domainEntries = Object.entries(srcFiles).filter(([file]) => file.startsWith('../../src/domain/'));
    expect(domainEntries.length).toBeGreaterThanOrEqual(9);
    for (const [file, content] of domainEntries) {
      expect(content, `${file} must not import env`).not.toMatch(/from\s+['"][^'"]*\/env['"]/);
      expect(content, `${file} must not import Durable Object runtime`).not.toMatch(/cloudflare:workers|DurableObject/);
      expect(content, `${file} must not import agendor/*/client`).not.toMatch(/agendor\/[^/'"]+\/client/);
      expect(content, `${file} must not call fetch`).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it('requires BudgetGate and InboxGuard on agendor clients without defaults', () => {
    expectTypeOf<Parameters<typeof createAgendorChatClient>[1]>().toEqualTypeOf<ChatClientOptions>();
    expectTypeOf<ChatClientOptions['budgetGate']>().toEqualTypeOf<BudgetGate>();
    expectTypeOf<ChatClientOptions['inboxGuard']>().toEqualTypeOf<InboxGuard>();
    expectTypeOf<Record<string, never>>().not.toMatchTypeOf<ChatClientOptions>();

    expectTypeOf<Parameters<typeof createAgendorCrmClient>[1]>().toEqualTypeOf<CrmClientOptions>();
    expectTypeOf<CrmClientOptions['budgetGate']>().toEqualTypeOf<BudgetGate>();
    expectTypeOf<Record<string, never>>().not.toMatchTypeOf<CrmClientOptions>();

    expectTypeOf<Parameters<typeof createCrmMutationClient>[0]>().toEqualTypeOf<CrmMutationDependencies>();
    expectTypeOf<CrmMutationDependencies['budgetGate']>().toEqualTypeOf<BudgetGate>();
    expectTypeOf<Omit<CrmMutationDependencies, 'budgetGate'>>().not.toMatchTypeOf<CrmMutationDependencies>();
  });
});
