import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { refreshTokenTtlForScopes } from '../src/oauth/lifetime.ts';

describe('OAuth refresh-token lifetime', () => {
  it('allows 35 days of renewal when offline access is approved', () => {
    assert.equal(refreshTokenTtlForScopes(['crm:read', 'offline_access']), 35 * 24 * 60 * 60);
  });

  it('does not issue a refresh token without offline access', () => {
    assert.equal(refreshTokenTtlForScopes(['crm:read']), 0);
  });
});
