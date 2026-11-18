import { describe, expect, it, vi } from 'vitest';
import { authenticateClient, requireScope } from '../src/auth';
import { RESOURCE } from '../src/oauth/config';

function context(scopes: string[]) {
  return {
    auth: {
      clientId: 'client-1',
      userId: 'owner-1',
      audience: RESOURCE,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      scope: scopes,
    },
    props: { userId: 'owner-1', email: 'owner@elo.example' },
  } as unknown as ExecutionContext;
}

describe('per-tool OAuth scopes', () => {
  it('retains Chat-only scopes without granting CRM access', () => {
    const auth = authenticateClient(context(['chat:read']));
    expect(auth.scopes).toEqual(['chat:read']);
    expect(() => requireScope(auth, 'crm:read')).toThrow('Insufficient scope.');
    try {
      requireScope(auth, 'crm:read');
    } catch (error) {
      expect(error).toMatchObject({ requiredScope: 'crm:read', status: 403 });
    }
    expect(() => requireScope(auth, 'chat:read')).not.toThrow();
  });

  it('does not treat crm:write as crm:read', () => {
    const auth = authenticateClient(context(['crm:write']));
    expect(() => requireScope(auth, 'crm:read')).toThrow('Insufficient scope.');
    expect(() => requireScope(auth, 'crm:write')).not.toThrow();
  });

  it('still rejects a different owner before evaluating scopes', () => {
    const request = context(['chat:read']) as ExecutionContext & { props: { email: string } };
    request.props.email = 'other@example.com';
    expect(() => authenticateClient(request)).toThrow('Unauthorized.');
  });
});

describe('OAuth authorization expiry', () => {
  it('normalizes OAuth seconds to exact milliseconds once', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_793_016_000_000);
    const request = context(['crm:read']);
    expect(authenticateClient(request)).toMatchObject({ expiresAt: 1_793_016_060_000 });
  });
  it.each([NaN, Infinity, -1, 0, 1_793_016_000])('rejects invalid or expired OAuth expiry %s', (expiresAt) => {
    vi.spyOn(Date, 'now').mockReturnValue(1_793_016_000_000);
    const request = context(['crm:read']);
    Object.assign(request, {
      auth: { clientId: 'client-1', userId: 'owner-1', audience: RESOURCE, scope: ['crm:read'], expiresAt },
    });
    expect(() => authenticateClient(request)).toThrow('Unauthorized.');
  });
  it('preserves callers whose verified context has no expiry', () => {
    const request = context([]);
    delete (request as unknown as { auth: { expiresAt?: number } }).auth.expiresAt;
    expect(authenticateClient(request)).toEqual({ clientId: 'client-1', userId: 'owner-1', scopes: [] });
  });
});
