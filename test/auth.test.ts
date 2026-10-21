import { describe, expect, it, vi } from 'vitest';
import { authenticateClient, timingSafeTokenEqual } from '../src/auth';
import worker from '../src/index';
import { context, testEnv } from './helpers';
import { issueTestToken } from './oauth-token';
import { RESOURCE } from '../src/oauth/config';

describe('OAuth authentication', () => {
  it.each([undefined, 'Basic x', 'Bearer ', 'Bearer x', 'Bearer unit-mcp-token', 'Bearer unit-mcp-token trailing', 'Bearer\tunit-mcp-token'])('rejects %s', async header => {
    const r=await worker.fetch(new Request(RESOURCE,{headers:header?{Authorization:header}:{}}),testEnv(),context());
    expect(r.status).toBe(401);
  });
  it('rejects a forged context or mismatched subject even after token validation',()=>{
    const ctx=context();
    expect(()=>authenticateClient(ctx)).toThrow();
    Object.assign(ctx,{props:{email:'owner@elo.example',userId:'other'},auth:{clientId:'client',userId:'owner',audience:RESOURCE,scope:['crm:read']}});
    expect(()=>authenticateClient(ctx)).toThrow();
  });
  it('uses fixed length timing safe digests for secret comparisons',async()=>{
    const compare=vi.spyOn(crypto.subtle,'timingSafeEqual');
    expect(await timingSafeTokenEqual('short','a much longer value')).toBe(false);
    expect(await timingSafeTokenEqual('a','a')).toBe(true);
    for(const [left,right] of compare.mock.calls){expect(left.byteLength).toBe(32);expect(right.byteLength).toBe(32);}
  });
  it.each([undefined,'','replace-me','bad\nvalue'])('fails closed with invalid CRM secret',async token=>{
    const env=testEnv({AGENDOR_CRM_TOKEN:token as string}); const grant=await issueTestToken(env);
    const r=await worker.fetch(new Request(RESOURCE,{headers:{Authorization:`Bearer ${grant.access_token}`}}),env,context());
    expect(r.status).toBe(503);expect(await r.text()).not.toContain(grant.access_token);
  });
});
