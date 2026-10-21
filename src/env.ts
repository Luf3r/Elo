export interface Env {
  AGENDOR_CRM_TOKEN: string;
  MCP_TEST_TOKEN: string;
  MCP_RATE_LIMITER: RateLimit;
  AGENDOR_CRM_RATE_LIMITER: RateLimit;
  AGENDOR_CHAT_TOKEN?: string;
}
