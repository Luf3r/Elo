import type { Env } from './env';

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === '/health' && request.method === 'GET') {
      return Response.json({ status: 'ok', service: 'elo-agendor-mcp', version: '0.1.0' });
    }
    return new Response('Not found', { status: 404 });
  },
};
