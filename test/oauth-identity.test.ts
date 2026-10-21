import { describe, expect, it, vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { readOAuthConfig } from '../src/oauth/config';
import { verifyAccessIdentity } from '../src/oauth/identity';
import { testEnv } from './helpers';

const fixture = {
  ACCESS_CLIENT_ID: 'unit-client', ACCESS_CLIENT_SECRET: 'unit-secret',
  ACCESS_ISSUER: 'https://elo-unit.cloudflareaccess.com',
  ACCESS_AUTHORIZATION_URL: 'https://elo-unit.cloudflareaccess.com/cdn-cgi/access/sso/oidc/unit-client/authorization',
  ACCESS_TOKEN_URL: 'https://elo-unit.cloudflareaccess.com/cdn-cgi/access/sso/oidc/unit-client/token',
  ACCESS_JWKS_URL: 'https://elo-unit.cloudflareaccess.com/cdn-cgi/access/sso/oidc/unit-client/jwks',
};

describe('Access identity boundary', () => {
  it.each([
    { ACCESS_ISSUER: 'https://attacker.example' },
    { ACCESS_JWKS_URL: 'https://attacker.example/jwks' },
    { ACCESS_TOKEN_URL: fixture.ACCESS_TOKEN_URL.replace('https:', 'http:') },
    { ACCESS_AUTHORIZATION_URL: fixture.ACCESS_AUTHORIZATION_URL + '?redirect=elsewhere' },
    { ACCESS_CLIENT_SECRET: '' },
    { ACCESS_CLIENT_ID: '../other' },
  ])('rejects unsafe/incomplete upstream configuration %j', override => {
    expect(() => readOAuthConfig({ ...testEnv(), ...fixture, ...override })).toThrow();
  });

  it.each([
    [{}, true], [{ email: 'other@example.com' }, false],
    [{ aud: 'other-client' }, false], [{ iss: 'https://attacker.example' }, false],
    [{ nonce: 'wrong-nonce' }, false], [{ exp: 1 }, false],
    [{ email: undefined }, false], [{ sub: '' }, false],
    [{ iat: Math.floor(Date.now()/1000) + 3600 }, false],
  ])('verifies signed identity claims %j', async (override, valid) => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...await exportJWK(publicKey), kid: 'unit-key', alg: 'RS256', use: 'sig' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ keys: [jwk] }));
    const now = Math.floor(Date.now()/1000);
    const token = await new SignJWT({ sub: 'owner-sub', email: 'owner@elo.example', nonce: 'bound-nonce', iss: fixture.ACCESS_ISSUER, aud: 'unit-client', iat: now, exp: now + 300, ...override })
      .setProtectedHeader({ alg: 'RS256', kid: 'unit-key' }).sign(privateKey);
    const result = verifyAccessIdentity(token, 'bound-nonce', readOAuthConfig({ ...testEnv(), ...fixture }));
    if (valid) await expect(result).resolves.toEqual({ userId: 'owner-sub', email: 'owner@elo.example' });
    else await expect(result).rejects.toThrow();
  });

  it('rejects a signature from an unrelated key', async () => {
    const signer = await generateKeyPair('RS256'); const verifier = await generateKeyPair('RS256');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ keys: [{ ...await exportJWK(verifier.publicKey), kid: 'key' }] }));
    const token = await new SignJWT({ sub:'owner', email:'owner@elo.example', nonce:'n' }).setIssuer(fixture.ACCESS_ISSUER).setAudience('unit-client').setIssuedAt().setExpirationTime('5m').setProtectedHeader({alg:'RS256',kid:'key'}).sign(signer.privateKey);
    await expect(verifyAccessIdentity(token,'n',readOAuthConfig({...testEnv(),...fixture}))).rejects.toThrow();
  });
});
