import { TENANT_SERVICE_NAME } from './app/config/tenant';
import type { Env } from './env';
import { oauthProvider } from './oauth/provider';
import { readOAuthConfig } from './oauth/config';
import { checkRegistrationQuota, recordRegistration } from './oauth/registration';
import { COMMIT, VERSION } from './version';
import { handleAutomationQueue } from './automation/execution/queue';
import { automationDomainHooks } from './automation/resolution';
import { AutomationAccount as BaseAutomationAccount } from './automation/state/account';
import { accountState } from './automation/state/budget';
import { errorFields, logEvent } from './shared/logger';

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    try {
      await accountState(env).maintainAccount(Date.now());
    } catch (error) {
      logEvent('error', 'watchdog_failed', errorFields(error));
      throw error;
    }
  },
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await handleAutomationQueue(batch, env);
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname: path } = new URL(request.url);
    if (path === '/health' && request.method === 'GET') {
      return Response.json({ status: 'ok', service: TENANT_SERVICE_NAME, version: VERSION, commit: COMMIT });
    }
    const known = [
      '/mcp',
      '/authorize',
      '/callback',
      '/token',
      '/token/revoke',
      '/register',
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ];
    if (!known.includes(path)) return new Response('Not found', { status: 404 });
    try {
      readOAuthConfig(env);
      if (!env.OAUTH_KV || !env.OAUTH_RATE_LIMITER || !env.REGISTER_RATE_LIMITER)
        throw new Error('Missing OAuth binding.');
      const ip = request.headers.get('CF-Connecting-IP')?.trim();
      if (!path.startsWith('/.well-known/') && path !== '/mcp') {
        if (!ip || !(await env.OAUTH_RATE_LIMITER.limit({ key: `oauth:${ip}` })).success)
          return Response.json(
            { error: 'temporarily_unavailable' },
            { status: 429, headers: { 'Retry-After': '10', 'Cache-Control': 'no-store' } },
          );
      }
      if (path === '/register' && request.method === 'POST') {
        if (!ip || !(await env.REGISTER_RATE_LIMITER.limit({ key: `register:${ip}` })).success)
          return Response.json(
            { error: 'temporarily_unavailable' },
            { status: 429, headers: { 'Retry-After': '10', 'Cache-Control': 'no-store' } },
          );
        const quota = await checkRegistrationQuota(env.OAUTH_KV, new Date());
        if (quota !== 'ok') {
          logEvent('warn', 'oauth_registration_rejected', {
            reason: quota === 'exhausted' ? 'daily_quota' : 'quota_unavailable',
          });
          return Response.json(
            {
              error: 'temporarily_unavailable',
              error_description: 'Client registration is temporarily unavailable.',
            },
            { status: 503, headers: { 'Cache-Control': 'no-store' } },
          );
        }
      }
      if (path === '/.well-known/oauth-protected-resource')
        request = new Request(new URL('/.well-known/oauth-protected-resource/mcp', request.url), request);
      const response = await oauthProvider.fetch(request, env, ctx);
      if (path === '/register' && request.method === 'POST' && response.status === 201) {
        const body: unknown = await response
          .clone()
          .json()
          .catch(() => null);
        const redirectUris =
          typeof body === 'object' && body !== null && 'redirect_uris' in body ? body.redirect_uris : undefined;
        await recordRegistration(env.OAUTH_KV, new Date(), Array.isArray(redirectUris) ? redirectUris.length : 0);
      }
      return response;
    } catch (error) {
      logEvent('error', 'auth_service_unavailable', { path, ...errorFields(error) });
      return Response.json(
        { error: 'temporarily_unavailable', error_description: 'Authentication service unavailable.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  },
};

export class AutomationAccount extends BaseAutomationAccount {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, automationDomainHooks);
  }
}
