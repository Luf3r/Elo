export interface Env {
  AGENDOR_CRM_TOKEN: string;
  MCP_TEST_TOKEN: string;
  MCP_RATE_LIMITER: RateLimit;
  AGENDOR_CRM_RATE_LIMITER: RateLimit;
  AGENDOR_CHAT_TOKEN?: string;
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
  ACCESS_ISSUER?: string;
  ACCESS_AUTHORIZATION_URL?: string;
  ACCESS_TOKEN_URL?: string;
  ACCESS_JWKS_URL?: string;
  OAUTH_KV?: KVNamespace;
  OAUTH_RATE_LIMITER?: RateLimit;
}
