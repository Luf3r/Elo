import type { Env } from './env';
import { authenticateClient, isConfiguredSecret } from './auth';
import { enforceRateLimit } from './rate-limit';
import { SafeError, errorData, safeError } from './errors';
import { createMcpHandler } from 'agents/mcp/server';
import { createServer } from './mcp/server';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === '/health' && request.method === 'GET') {
      return Response.json({ status: 'ok', service: 'elo-agendor-mcp', version: '0.1.0' });
    }
    if (new URL(request.url).pathname === '/mcp') {
      try {
        const auth = await authenticateClient(request, env);
        await enforceRateLimit(env, auth);
        if (!isConfiguredSecret(env.AGENDOR_CRM_TOKEN)) throw new SafeError('UPSTREAM_UNAVAILABLE', 'CRM service is not configured.', false, 503);
        const response = await createMcpHandler(() => createServer(env, auth, request.signal), { corsOptions: false })(request, env, ctx);
        response.headers.set('Cache-Control', 'no-store');
        return response;
      } catch (error) {
        const safe = safeError(error);
        return Response.json({ error: errorData(safe) }, {
          status: safe.status ?? 503,
          headers: { 'Cache-Control': 'no-store', ...(safe.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="elo-agendor-mcp"' } : {}), ...(safe.status === 429 ? { 'Retry-After': '10' } : {}) },
        });
      }
    }
    return new Response('Not found', { status: 404 });
  },
};
