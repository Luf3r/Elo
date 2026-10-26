import {env} from 'cloudflare:test';
import {it,expect} from 'vitest';
import {generateKeyPair,SignJWT} from 'jose';
import {verifyAccessIdentity} from '../../src/oauth/identity';
import {readOAuthConfig} from '../../src/oauth/config';
it.skipIf(!env.ACCESS_CLIENT_SECRET)('the production verifier reaches Access public JWKS using Workers-supported fetch options',async()=>{
  const response=await fetch(env.ACCESS_JWKS_URL,{redirect:'manual',signal:AbortSignal.timeout(10000)});
  expect(response.status).toBe(200);
  const data=await response.json() as {keys:{kid:string}[]};
  expect(data.keys.length).toBeGreaterThan(0);
  const {privateKey}=await generateKeyPair('RS256');
  const token=await new SignJWT({sub:'probe',email:'owner@elo.example',nonce:'probe-nonce'})
    .setProtectedHeader({alg:'RS256',kid:data.keys[0]!.kid}).setIssuer(env.ACCESS_ISSUER).setAudience(env.ACCESS_CLIENT_ID).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  // A deliberately unrelated signing key must fail at signature verification, after the real JWKS fetch.
  await expect(verifyAccessIdentity(token,'probe-nonce',readOAuthConfig(env))).rejects.toMatchObject({code:'ERR_JWS_SIGNATURE_VERIFICATION_FAILED'});
});
