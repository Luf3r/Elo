import { OAuthProvider, OAuthError, type OAuthProviderOptions, insufficientScope } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp/server';
import type { Env } from '../env';
import { authenticateClient, isConfiguredSecret } from '../auth';
import { enforceRateLimit } from '../rate-limit';
import { SafeError, errorData, safeError } from '../errors';
import { createServer } from '../mcp/server';
import { ORIGIN, RESOURCE, READ_SCOPE, OWNER_EMAIL } from './config';
import { loginHandler } from './handler';

export const oauthOptions: OAuthProviderOptions<Env> = {
  apiRoute:'/mcp', authorizeEndpoint:'/authorize', tokenEndpoint:'/token', clientRegistrationEndpoint:'/register',
  resourceMetadata:{resource:RESOURCE,authorization_servers:[ORIGIN]},
  scopesSupported:[READ_SCOPE,'offline_access'],requiredScopes:[READ_SCOPE],
  accessTokenTTL:3600,refreshTokenTTL:7*24*3600,clientRegistrationTTL:90*24*3600,
  clientIdMetadataDocumentEnabled:true,
  onError:()=>undefined,
  defaultHandler:loginHandler,
  apiHandler:{async fetch(request,env,ctx){
    if(new URL(request.url).pathname!=='/mcp')return new Response('Not found',{status:404});
    try {
      const auth=authenticateClient(ctx);
      await enforceRateLimit(env,auth);
      if(!isConfiguredSecret(env.AGENDOR_CRM_TOKEN))throw new SafeError('UPSTREAM_UNAVAILABLE','CRM service is not configured.',false,503);
      const response=await createMcpHandler(()=>createServer(env,auth,request.signal),{corsOptions:false})(request,env,ctx);
      response.headers.set('Cache-Control','no-store');return response;
    }catch(error){
      const safe=safeError(error);
      if(safe.status===403)return insufficientScope({token:'',audience:RESOURCE,scope:[]},[READ_SCOPE]);
      return Response.json({error:errorData(safe)},{status:safe.status??503,headers:{'Cache-Control':'no-store',...(safe.status===401?{'WWW-Authenticate':`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`}:{}),...(safe.status===429?{'Retry-After':'10'}:{})}});
    }
  }},
  tokenExchangeCallback:async options=>{
    const props:unknown=options.props;
    if(!props || typeof props!=='object' || !('email' in props) || props.email!==OWNER_EMAIL)throw new OAuthError('invalid_grant',{description:'Identity is not authorized.'});
    return {refreshTokenTTL:options.scope.includes('offline_access')?7*24*3600:0};
  },
};
export const oauthProvider = new OAuthProvider<Env>(oauthOptions);
