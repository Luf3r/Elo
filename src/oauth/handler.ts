import { AuthorizationError, CimdFetchError, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
import type { Env } from '../env';
import { errorFields, logEvent } from '../shared/logger';
import { readBoundedBody } from '../shared/bounded-body';
import { readOAuthConfig, ORIGIN, OPTIONAL_SCOPE, SUPPORTED_SCOPES, type OAuthConfig } from './config';
import { verifyAccessIdentity } from './identity';
import { consentPage } from './consent';
import { oauthFailureDiagnostic } from './diagnostics';

export async function limitedText(body: ReadableStream<Uint8Array> | null, max: number): Promise<string> {
  if (!body) return '';
  const result = await readBoundedBody(body, max, { awaitCancel: true });
  if (result.kind === 'too_large') throw new RangeError('Body too large.');
  if (result.kind === 'non_binary') throw new TypeError('Body is not binary.');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(result.bytes);
}
function pageError(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
async function exchangeIdentity(code: string, verifier: string, nonce: string, config: OAuthConfig) {
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    redirect: 'manual',
    signal: timeout,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: verifier,
      redirect_uri: `${ORIGIN}/callback`,
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Identity provider unavailable.');
  }
  const data: unknown = JSON.parse(await limitedText(response.body, 65_536));
  if (!data || typeof data !== 'object' || !('id_token' in data) || typeof data.id_token !== 'string')
    throw new Error('Invalid identity response.');
  return verifyAccessIdentity(data.id_token, nonce, config);
}
export const loginHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname !== '/authorize' && pathname !== '/callback') return new Response('Not found', { status: 404 });
    const oauth = env.OAUTH_PROVIDER;
    if (!oauth) return pageError(503, 'O login ainda não está configurado.');
    let phase: 'authorization_request' | 'consent_description' | 'consent_creation' = 'authorization_request';
    let config: OAuthConfig;
    try {
      config = readOAuthConfig(env);
    } catch {
      return pageError(503, 'O login ainda não está configurado.');
    }
    try {
      if (pathname === '/authorize' && request.method === 'GET') {
        const auth = await oauth.parseAuthRequest(request);
        if (!auth.codeChallenge || auth.codeChallengeMethod !== 'S256')
          return pageError(400, 'Este aplicativo precisa usar PKCE S256.');
        if (auth.scope.some((scope) => !SUPPORTED_SCOPES.includes(scope)))
          return pageError(400, 'Permissões inválidas.');
        // Offer renewable access in the browser-bound consent even when the MCP client omits it.
        auth.scope = [...new Set([...auth.scope, OPTIONAL_SCOPE])];
        phase = 'consent_description';
        const details = await oauth.describeConsent(auth);
        phase = 'consent_creation';
        const consent = await oauth.beginConsent(auth);
        consent.headers.set('Content-Type', 'text/html; charset=utf-8');
        consent.headers.set('Referrer-Policy', 'no-referrer');
        return new Response(consentPage(details, consent.handle), { headers: consent.headers });
      }
      if (pathname === '/authorize' && request.method === 'POST') {
        if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))
          return pageError(415, 'Formato inválido.');
        const form = new URLSearchParams(await limitedText(request.body, 16_384));
        if (form.getAll('handle').length !== 1 || form.getAll('decision').length !== 1)
          return pageError(400, 'Solicitação inválida.');
        const handle = form.get('handle')!;
        if (form.get('decision') === 'deny') {
          const denied = await oauth.denyConsent(request, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        if (form.get('decision') !== 'approve') return pageError(400, 'Solicitação inválida.');
        const approved = await oauth.approveConsent(request, handle);
        const verifier = crypto.randomUUID() + crypto.randomUUID();
        const nonce = crypto.randomUUID();
        const { state, headers } = await oauth.beginUpstream(approved.request, {
          data: { verifier, nonce },
          headers: approved.headers,
        });
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
        const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=/g, '');
        const url = new URL(config.authorizationUrl);
        url.search = new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: `${ORIGIN}/callback`,
          response_type: 'code',
          scope: 'openid email',
          state,
          nonce,
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }).toString();
        headers.set('Location', url.href);
        headers.set('Referrer-Policy', 'no-referrer');
        return new Response(null, { status: 302, headers });
      }
      if (pathname === '/callback' && request.method === 'GET') {
        const resumed = await oauth.finishUpstream<{ verifier: string; nonce: string }>(request);
        if (searchParams.has('error')) {
          resumed.headers.set('Location', authorizationErrorRedirect(resumed.request, 'access_denied'));
          return new Response(null, { status: 302, headers: resumed.headers });
        }
        const code = searchParams.get('code');
        if (!code || searchParams.getAll('code').length !== 1 || !resumed.data?.nonce || !resumed.data.verifier)
          return pageError(400, 'Retorno de login inválido.');
        let identity;
        try {
          identity = await exchangeIdentity(code, resumed.data.verifier, resumed.data.nonce, config);
        } catch (error) {
          logEvent('warn', 'oauth_identity_exchange_failed', errorFields(error));
          return pageError(
            403,
            'Não foi possível autorizar este login. Inicie a conexão novamente com o e-mail permitido.',
          );
        }
        const { redirectTo } = await oauth.completeAuthorization({
          request: resumed.request,
          userId: identity.userId,
          scope: resumed.request.scope,
          metadata: { label: 'Elo Agendor' },
          props: identity,
        });
        resumed.headers.set('Location', redirectTo);
        resumed.headers.set('Referrer-Policy', 'no-referrer');
        return new Response(null, { status: 302, headers: resumed.headers });
      }
      return pageError(405, 'Método não permitido.');
    } catch (error) {
      if (pathname === '/authorize' && request.method === 'GET')
        logEvent('warn', 'oauth_authorization_failed', oauthFailureDiagnostic(phase, error));
      if (pathname === '/authorize' && request.method === 'POST')
        logEvent('warn', 'oauth_consent_failed', errorFields(error));
      if (pathname === '/callback') logEvent('warn', 'oauth_callback_failed', errorFields(error));
      if (error instanceof RangeError) return pageError(413, 'Solicitação muito grande.');
      if (error instanceof AuthorizationError || error instanceof CimdFetchError || error instanceof TypeError)
        return pageError(400, 'Solicitação inválida ou expirada. Inicie a conexão novamente.');
      return pageError(503, 'O login está temporariamente indisponível.');
    }
  },
};
