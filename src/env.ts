import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
export interface Env extends WorkerBindings {
  MCP_TEST_TOKEN?: string;
  AGENDOR_CHAT_TOKEN?: string;
  AGENDOR_CHAT_ACCOUNT_ID?: string;
  AGENDOR_CHAT_RATE_LIMITER: RateLimit;
  OAUTH_PROVIDER?: OAuthHelpers;
}