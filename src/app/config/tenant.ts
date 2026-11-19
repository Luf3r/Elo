import { DEPLOYMENT } from './deployment';

/** Tenant-wide identifiers and security-pinned inbox scope. */
export const TENANT_ACCOUNT_KEY: string = DEPLOYMENT.tenantKey;

/** Expansion is a deliberate code/policy change, never derived from upstream data. */
export const ALLOWED_INBOX_IDS: readonly number[] = DEPLOYMENT.allowedInboxIds;

export const TENANT_SERVICE_NAME = 'elo-agendor-mcp' as const;
