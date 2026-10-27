import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
export interface Env extends WorkerBindings {
  MCP_TEST_TOKEN?: string;
  AGENDOR_CHAT_TOKEN?: string;
  AUTOMATION_CHAT_HINTS_ENABLED?: string;
  OAUTH_PROVIDER?: OAuthHelpers;
}
