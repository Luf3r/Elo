import type { Env } from '../../env';
import { isConfiguredSecret } from '../../shared/secrets';

export function isCrmConfigured(env: Partial<Pick<Env, 'AGENDOR_CRM_TOKEN'>>): boolean {
  return isConfiguredSecret(env.AGENDOR_CRM_TOKEN);
}

export function isChatConfigured(env: Partial<Pick<Env, 'AGENDOR_CHAT_TOKEN' | 'AGENDOR_CHAT_ACCOUNT_ID'>>): boolean {
  return isConfiguredSecret(env.AGENDOR_CHAT_TOKEN) && /^\d{1,20}$/.test(env.AGENDOR_CHAT_ACCOUNT_ID ?? '');
}
