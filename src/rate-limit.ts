import type { Env } from './env';
import type { AuthContext } from './auth';
import { SafeError } from './errors';

async function limit(binding: RateLimit | undefined, key: string): Promise<boolean> {
  try {
    if (!binding) throw new Error('missing limiter');
    return (await binding.limit({ key })).success;
  } catch { throw new SafeError('UPSTREAM_UNAVAILABLE', 'Rate limit service unavailable.', true, 503); }
}
export async function enforceRateLimit(env: Env, auth: AuthContext): Promise<void> {
  if (!await limit(env.MCP_RATE_LIMITER, `mcp:${auth.clientId}`)) {
    throw new SafeError('MCP_RATE_LIMITED', 'Request limit reached. Retry later.', true, 429);
  }
}
export async function enforceCrmRateLimit(env: Pick<Env, 'AGENDOR_CRM_RATE_LIMITER'>): Promise<void> {
  if (!await limit(env.AGENDOR_CRM_RATE_LIMITER, 'agendor-crm:shared')) {
    throw new SafeError('UPSTREAM_RATE_LIMITED', 'CRM request budget reached. Retry later.', true, 429);
  }
}
export async function enforceChatRateLimit(env: Pick<Env, 'AGENDOR_CHAT_RATE_LIMITER'>): Promise<void> {
  if (!await limit(env.AGENDOR_CHAT_RATE_LIMITER, 'agendor-chat:shared')) {
    throw new SafeError('UPSTREAM_RATE_LIMITED', 'Chat request budget reached. Retry later.', true, 429);
  }
}