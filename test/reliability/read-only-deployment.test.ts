import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const globalRecord = globalThis as { __ELO_DEPLOYMENT__?: unknown };

const BASE_DEPLOYMENT = {
  origin: 'https://example.workers.dev',
  ownerEmail: 'owner@example.com',
  tenantKey: 'tenant-1',
  allowedInboxIds: [101, 202],
};

const WRITE_SCOPES = ['crm:write', 'crm:create', 'crm:enrich', 'automation:process', 'automation:manage'];
const READ_SCOPES = ['crm:read', 'chat:read', 'automation:read', 'offline_access'];

async function loadWith(deployment: Record<string, unknown>) {
  globalRecord.__ELO_DEPLOYMENT__ = deployment;
  vi.resetModules();
  const [deploymentModule, config, auth] = await Promise.all([
    import('../../src/app/config/deployment'),
    import('../../src/oauth/config'),
    import('../../src/auth'),
  ]);
  return { deployment: deploymentModule.DEPLOYMENT, config, auth };
}

function contextFor(scopes: string[]): ExecutionContext {
  return {
    auth: {
      clientId: 'client-1',
      userId: 'user-1',
      audience: 'https://example.workers.dev/mcp',
      scope: scopes,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    },
    props: { email: 'owner@example.com', userId: 'user-1' },
  } as unknown as ExecutionContext;
}

describe('read-only deployment', () => {
  let originalDeployment: unknown;

  beforeEach(() => {
    originalDeployment = globalRecord.__ELO_DEPLOYMENT__;
  });

  afterEach(() => {
    if (originalDeployment === undefined) delete globalRecord.__ELO_DEPLOYMENT__;
    else globalRecord.__ELO_DEPLOYMENT__ = originalDeployment;
    vi.resetModules();
  });

  it('defaults to a full deployment that supports every product scope', async () => {
    const { deployment, config } = await loadWith(BASE_DEPLOYMENT);
    expect(deployment.readOnly).toBe(false);
    expect([...config.SUPPORTED_SCOPES].sort()).toEqual([...READ_SCOPES, ...WRITE_SCOPES].sort());
  });

  it('rejects a non-boolean readOnly flag', async () => {
    globalRecord.__ELO_DEPLOYMENT__ = { ...BASE_DEPLOYMENT, readOnly: 'true' };
    vi.resetModules();
    await expect(import('../../src/app/config/deployment')).rejects.toThrow(
      'Deployment configuration is missing or invalid.',
    );
  });

  it('supports only read scopes when readOnly is true', async () => {
    const { deployment, config } = await loadWith({ ...BASE_DEPLOYMENT, readOnly: true });
    expect(deployment.readOnly).toBe(true);
    expect([...config.SUPPORTED_SCOPES].sort()).toEqual([...READ_SCOPES].sort());
    for (const scope of WRITE_SCOPES) expect(config.SUPPORTED_SCOPES).not.toContain(scope);
  });

  it('drops write grants from tokens on a read-only deployment so write tools fail closed', async () => {
    const { auth } = await loadWith({ ...BASE_DEPLOYMENT, readOnly: true });
    const context = auth.authenticateClient(contextFor([...READ_SCOPES, ...WRITE_SCOPES]));
    expect([...context.scopes].sort()).toEqual([...READ_SCOPES].sort());
    expect(() => auth.requireScope(context, 'crm:write')).toThrow('Insufficient scope.');
    expect(() => auth.requireScope(context, 'crm:read')).not.toThrow();
  });

  it('keeps every known grant on a full deployment and drops only unknown scopes', async () => {
    const { auth } = await loadWith(BASE_DEPLOYMENT);
    const context = auth.authenticateClient(contextFor([...READ_SCOPES, ...WRITE_SCOPES, 'unknown:scope']));
    expect([...context.scopes].sort()).toEqual([...READ_SCOPES, ...WRITE_SCOPES].sort());
  });
});
