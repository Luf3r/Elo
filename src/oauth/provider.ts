import { OAuthProvider, OAuthError, type OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp/server';
import type { Env } from '../env';
import { authenticateClient } from '../auth';
import { enforceRateLimit } from '../shared/rate-limit';
import { errorData, SafeError, safeError } from '../shared/errors';
import { errorFields, logEvent } from '../shared/logger';
import { createServer } from '../mcp/server';
import { ORIGIN, RESOURCE, OWNER_EMAIL, SUPPORTED_SCOPES } from './config';
import { loginHandler } from './handler';
import { ACCESS_TOKEN_TTL_SECONDS, OFFLINE_REFRESH_TOKEN_TTL_SECONDS, refreshTokenTtlForScopes } from './lifetime';

export const oauthOptions: OAuthProviderOptions<Env> = {
  apiRoute: '/mcp',
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  resourceMetadata: { resource: RESOURCE, authorization_servers: [ORIGIN] },
  scopesSupported: [...SUPPORTED_SCOPES],
  accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
  refreshTokenTTL: OFFLINE_REFRESH_TOKEN_TTL_SECONDS,
  clientRegistrationTTL: 90 * 24 * 3600,
  // ChatGPT CIMD currently returns HTTP 404; use the existing /register DCR flow.
  clientIdMetadataDocumentEnabled: false,
  onError: () => undefined,
  defaultHandler: loginHandler,
  apiHandler: {
    async fetch(request, env, ctx) {
      if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', { status: 404 });
      try {
        const auth = authenticateClient(ctx);
        await enforceRateLimit(env, auth);
        const response = await createMcpHandler(() => createServer(env, auth, request.signal), { corsOptions: false })(
          request,
          env,
          ctx,
        );
        response.headers.set('Cache-Control', 'no-store');
        return response;
      } catch (error) {
        if (!(error instanceof SafeError)) {
          logEvent('error', 'mcp_request_failed', errorFields(error));
        }
        const safe = safeError(error);
        return Response.json(
          { error: errorData(safe) },
          {
            status: safe.status ?? 503,
            headers: {
              'Cache-Control': 'no-store',
              ...(safe.status === 401
                ? {
                    'WWW-Authenticate': `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
                  }
                : {}),
              ...(safe.status === 429 ? { 'Retry-After': '10' } : {}),
            },
          },
        );
      }
    },
  },
  tokenExchangeCallback: async (options) => {
    const props: unknown = options.props;
    if (!props || typeof props !== 'object' || !('email' in props) || props.email !== OWNER_EMAIL)
      throw new OAuthError('invalid_grant', { description: 'Identity is not authorized.' });
    return { refreshTokenTTL: refreshTokenTtlForScopes(options.scope) };
  },
};
export const oauthProvider = new OAuthProvider<Env>(oauthOptions);
