import type { Env } from './env';
import { oauthProvider } from './oauth/provider';
import { readOAuthConfig } from './oauth/config';
import { VERSION } from './version';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === '/health' && request.method === 'GET') {
      return Response.json({ status: 'ok', service: 'elo-agendor-mcp', version: VERSION });
    }
    const path=new URL(request.url).pathname;
    const known=['/mcp','/authorize','/callback','/token','/token/revoke','/register','/.well-known/oauth-authorization-server','/.well-known/openid-configuration','/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'];
    if(!known.includes(path))return new Response('Not found',{status:404});
    try {
      readOAuthConfig(env);
      if(!env.OAUTH_KV || !env.OAUTH_RATE_LIMITER)throw new Error('Missing OAuth binding.');
      if(!path.startsWith('/.well-known/') && path!=='/mcp'){
        const ip=request.headers.get('CF-Connecting-IP') ?? 'unknown';
        if(!(await env.OAUTH_RATE_LIMITER.limit({key:`oauth:${ip}`})).success)return Response.json({error:'temporarily_unavailable'},{status:429,headers:{'Retry-After':'10','Cache-Control':'no-store'}});
      }
      if(path==='/.well-known/oauth-protected-resource')request=new Request(new URL('/.well-known/oauth-protected-resource/mcp',request.url),request);
      return await oauthProvider.fetch(request,env,ctx);
    }catch{return Response.json({error:'temporarily_unavailable',error_description:'Authentication service unavailable.'},{status:503,headers:{'Cache-Control':'no-store'}});}
  },
};
