import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
export interface Env extends WorkerBindings {
  MCP_TEST_TOKEN?: string;
  AGENDOR_CHAT_TOKEN?: string;
  OAUTH_PROVIDER?: OAuthHelpers;
}
