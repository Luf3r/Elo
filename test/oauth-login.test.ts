import { describe, it, expect, vi } from 'vitest';
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { loginHandler } from '../src/oauth/handler';
import { oauthFailureDiagnostic } from '../src/oauth/diagnostics';
import { baseOptions, oauthEnv, providerFetch, startAuthorization, cookies, simulateAccess } from './oauth-helper';

const provider = () => new OAuthProvider({ ...baseOptions, defaultHandler:loginHandler, apiHandler:{fetch:async()=>Response.json({ok:true})} });

describe('owner-only browser login', () => {
  it('requires S256 even for a confidential client',async()=>{
    const p=provider(),env=oauthEnv();
    const registered=await providerFetch(p,env,'/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Confidential',redirect_uris:['https://client.example/callback'],grant_types:['authorization_code'],response_types:['code'],token_endpoint_auth_method:'client_secret_post'})});
    expect(registered.status).toBe(201); const client=await registered.json() as {client_id:string};
    const response=await providerFetch(p,env,'/authorize?'+new URLSearchParams({client_id:client.client_id,response_type:'code',redirect_uri:'https://client.example/callback',resource:'https://elo-agendor-mcp.example.workers.dev/mcp',scope:'crm:read'}));
    expect(response.status).toBe(400);expect(response.headers.get('location')).toBeNull();
  });
  it('shows escaped consent metadata and destination with secure browser binding', async () => {
    const p = provider(), env = oauthEnv();
    const start = await startAuthorization(p,env,'<script>alert("x")</script>');
    expect(start.response.status).toBe(200);
    expect(start.html).toContain('client.example');
    expect(start.html).not.toContain('<script>');
    expect(start.html).toContain('crm:read');
    expect(start.response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(cookies(start.response)).toContain('__Host-');
  });
  it('refuses approval without the original browser cookie', async () => {
    const p=provider(), env=oauthEnv(), start=await startAuthorization(p,env);
    const result=await providerFetch(p,env,'/authorize',{method:'POST',body:new URLSearchParams({handle:start.handle!,decision:'approve'})});
    expect(result.status).toBe(400); expect(result.headers.get('location')).toBeNull();
  });
  it('returns access_denied without contacting Access when declined', async () => {
    const p=provider(),env=oauthEnv(),start=await startAuthorization(p,env);
    const result=await providerFetch(p,env,'/authorize',{method:'POST',headers:{Cookie:cookies(start.response)},body:new URLSearchParams({handle:start.handle!,decision:'deny'})});
    expect(result.status).toBe(302); const url=new URL(result.headers.get('location')!);
    expect(url.origin).toBe('https://client.example'); expect(url.searchParams.get('error')).toBe('access_denied');
  });
  it.each([false,true])('checks email and binds callback to browser (wrongEmail=%s)',async wrongEmail=>{
    const p=provider(),env=oauthEnv(),start=await startAuthorization(p,env);
    const approved=await providerFetch(p,env,'/authorize',{method:'POST',headers:{Cookie:cookies(start.response)},body:new URLSearchParams({handle:start.handle!,decision:'approve'})});
    expect(approved.status).toBe(302); const access=new URL(approved.headers.get('location')!);
    expect(access.hostname).toBe('elo-unit.cloudflareaccess.com');
    expect(access.searchParams.get('code_challenge_method')).toBe('S256');
    expect(access.searchParams.get('redirect_uri')).toBe('https://elo-agendor-mcp.example.workers.dev/callback');
    const mock=await simulateAccess(access.searchParams.get('nonce')!,wrongEmail?{email:'attacker@example.com'}:{});
    const callback='/callback?'+new URLSearchParams({code:'access-code',state:access.searchParams.get('state')!});
    expect((await providerFetch(p,env,callback)).status).toBe(400);
    const result=await providerFetch(p,env,callback,{headers:{Cookie:cookies(start.response,approved)}});
    if(wrongEmail){expect(result.status).toBe(403);expect(result.headers.get('location')).toBeNull();}
    else {expect(result.status).toBe(302);const back=new URL(result.headers.get('location')!);expect(back.origin).toBe('https://client.example');expect(back.searchParams.has('code')).toBe(true);expect(await result.text()).not.toContain('upstream-not-for-client');}
    expect(mock).toHaveBeenCalled();
  });
  it('rejects an oversized approval body without redirecting',async()=>{
    const r=await providerFetch(provider(),oauthEnv(),'/authorize',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'handle='+ 'x'.repeat(17000)});
    expect(r.status).toBe(413);
  });
  it('does not redirect a client with an unregistered callback',async()=>{
    const r=await providerFetch(provider(),oauthEnv(),'/authorize?client_id=missing&redirect_uri=https://evil.example&response_type=code');
    expect(r.status).toBe(400); expect(r.headers.get('location')).toBeNull();
  });
  it('logs safe authorization failure details without OAuth request secrets',async()=>{
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
    const query=new URLSearchParams({client_id:'missing',redirect_uri:'https://evil.example/callback',response_type:'code',state:'private-state-value',code_challenge:'private-challenge-value'});
    try {
      const response=await providerFetch(provider(),oauthEnv(),'/authorize?'+query);
      expect(response.status).toBe(400);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({event:'oauth_authorization_failed',phase:'authorization_request',errorType:'AuthorizationError',code:'invalid_request'}));
      const logged=JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain('private-state-value');
      expect(logged).not.toContain('private-challenge-value');
      expect(logged).not.toContain('evil.example');
    } finally { warn.mockRestore(); }
  });
  it('reports CIMD failure class and HTTP status without logging metadata content',()=>{
    const diagnostic=oauthFailureDiagnostic('authorization_request',Object.assign(new Error('private payload'),{name:'CimdFetchError',detail:'Failed to fetch client metadata: HTTP 503',metadataUrl:'https://client.example/private?token=hidden'}));
    expect(diagnostic).toEqual({phase:'client_metadata_resolution',errorType:'CimdFetchError',failure:'upstream_http_error',upstreamStatus:503});
    expect(JSON.stringify(diagnostic)).not.toContain('private');
    expect(JSON.stringify(diagnostic)).not.toContain('hidden');
  });
});
