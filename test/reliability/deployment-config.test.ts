/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const srcFiles = import.meta.glob<string>('../../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const globalRecord = globalThis as { __ELO_DEPLOYMENT__?: unknown };

const VALID_DEPLOYMENT = {
  origin: 'https://example.workers.dev/',
  ownerEmail: 'owner@example.com',
  tenantKey: 'tenant-1',
  allowedInboxIds: [101, 202],
};

async function loadDeploymentWith(value: unknown) {
  if (value === undefined) {
    delete globalRecord.__ELO_DEPLOYMENT__;
  } else {
    globalRecord.__ELO_DEPLOYMENT__ = value;
  }
  vi.resetModules();
  return import('../../src/app/config/deployment');
}

describe('deployment configuration', () => {
  let originalDeployment: unknown;

  beforeEach(() => {
    originalDeployment = globalRecord.__ELO_DEPLOYMENT__;
  });

  afterEach(() => {
    if (originalDeployment === undefined) {
      delete globalRecord.__ELO_DEPLOYMENT__;
    } else {
      globalRecord.__ELO_DEPLOYMENT__ = originalDeployment;
    }
    vi.resetModules();
  });

  it('fails closed when deployment configuration is missing', async () => {
    await expect(loadDeploymentWith(undefined)).rejects.toThrow('Deployment configuration is missing or invalid.');
    await expect(loadDeploymentWith(null)).rejects.toThrow('Deployment configuration is missing or invalid.');
  });

  it('rejects invalid origin values without echoing the input', async () => {
    const invalidOrigins = [
      'https://example.workers.dev/mcp',
      'http://example.workers.dev',
      'https://example.workers.dev?a=1',
      'https://example.workers.dev#frag',
      'https://example.workers.dev:8443',
      'https://example.workers.dev:443',
      'https://user:secret@example.workers.dev',
      'not-a-url',
    ];
    for (const origin of invalidOrigins) {
      await expect(loadDeploymentWith({ ...VALID_DEPLOYMENT, origin })).rejects.toThrow(
        /^Deployment configuration is missing or invalid\.$/,
      );
    }
  });

  it('rejects invalid ownerEmail values without echoing the input', async () => {
    for (const ownerEmail of ['not-an-email', 'missing-domain@', '']) {
      await expect(loadDeploymentWith({ ...VALID_DEPLOYMENT, ownerEmail })).rejects.toThrow(
        /^Deployment configuration is missing or invalid\.$/,
      );
    }
  });

  it('rejects invalid tenantKey values without echoing the input', async () => {
    for (const tenantKey of ['Elo', '1tenant', 'bad_key', '', 'a'.repeat(33)]) {
      await expect(loadDeploymentWith({ ...VALID_DEPLOYMENT, tenantKey })).rejects.toThrow(
        /^Deployment configuration is missing or invalid\.$/,
      );
    }
  });

  it('rejects empty, duplicate, oversized, or non-safe-integer allowedInboxIds', async () => {
    const invalidAllowlists: unknown[] = [
      [],
      [4101, 4101],
      [1.5],
      [0],
      [-1],
      [Number.MAX_SAFE_INTEGER + 1],
      ['4101'],
      Array.from({ length: 51 }, (_, i) => i + 1),
    ];
    for (const allowedInboxIds of invalidAllowlists) {
      await expect(loadDeploymentWith({ ...VALID_DEPLOYMENT, allowedInboxIds })).rejects.toThrow(
        /^Deployment configuration is missing or invalid\.$/,
      );
    }
  });

  it('rejects unexpected extra keys', async () => {
    await expect(loadDeploymentWith({ ...VALID_DEPLOYMENT, extra: 'nope' })).rejects.toThrow(
      /^Deployment configuration is missing or invalid\.$/,
    );
  });

  it('normalizes trailing slash on origin and exports a deeply frozen DEPLOYMENT', async () => {
    const { DEPLOYMENT } = await loadDeploymentWith(VALID_DEPLOYMENT);
    expect(DEPLOYMENT).toEqual({
      origin: 'https://example.workers.dev',
      ownerEmail: 'owner@example.com',
      tenantKey: 'tenant-1',
      allowedInboxIds: [101, 202],
    });
    expect(Object.isFrozen(DEPLOYMENT)).toBe(true);
    expect(Object.isFrozen(DEPLOYMENT.allowedInboxIds)).toBe(true);
  });

  it('keeps test deployment origin, ownerEmail, and allowedInboxIds out of src/ except deployment.ts', async () => {
    vi.resetModules();
    const { DEPLOYMENT } = await import('../../src/app/config/deployment');
    const forbiddenLiterals = [
      DEPLOYMENT.origin,
      DEPLOYMENT.ownerEmail,
      ...DEPLOYMENT.allowedInboxIds.map((id) => String(id)),
    ];
    const entries = Object.entries(srcFiles);
    expect(entries.length).toBeGreaterThan(30);

    for (const [file, content] of entries) {
      if (file === '../../src/app/config/deployment.ts') continue;
      for (const literal of forbiddenLiterals) {
        expect(content, `${file} must not contain deployment literal ${literal}`).not.toContain(literal);
      }
    }
  });

  it('keeps tenantKey out of src/domain/, src/oauth/config.ts, and src/app/config/tenant.ts', async () => {
    vi.resetModules();
    const { DEPLOYMENT } = await import('../../src/app/config/deployment');
    const tenantKey = DEPLOYMENT.tenantKey.toLowerCase();

    const domainEntries = Object.entries(srcFiles).filter(([file]) => file.startsWith('../../src/domain/'));
    expect(domainEntries.length).toBeGreaterThan(0);
    for (const [file, content] of domainEntries) {
      expect(content.toLowerCase(), `${file} must not contain tenantKey ${DEPLOYMENT.tenantKey}`).not.toContain(
        tenantKey,
      );
    }

    const oauthConfig = srcFiles['../../src/oauth/config.ts'];
    expect(oauthConfig).toBeDefined();
    if (oauthConfig === undefined) throw new Error('Expected src/oauth/config.ts to be loaded');
    expect(oauthConfig.toLowerCase(), 'src/oauth/config.ts must not contain tenantKey').not.toContain(tenantKey);

    const tenantConfig = srcFiles['../../src/app/config/tenant.ts'];
    expect(tenantConfig).toBeDefined();
    if (tenantConfig === undefined) throw new Error('Expected src/app/config/tenant.ts to be loaded');
    const tenantConfigWithoutServiceName = tenantConfig.replace(
      "export const TENANT_SERVICE_NAME = 'elo-agendor-mcp' as const;",
      '',
    );
    expect(
      tenantConfigWithoutServiceName.toLowerCase(),
      'src/app/config/tenant.ts must not contain tenantKey outside TENANT_SERVICE_NAME',
    ).not.toContain(tenantKey);
  });
});
