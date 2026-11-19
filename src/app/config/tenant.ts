/** Tenant-wide identifiers and security-pinned inbox scope for Elo. */
export const TENANT_ACCOUNT_KEY = 'elotenant' as const;

/** Expansion is a deliberate code/policy change, never derived from upstream data. */
export const ALLOWED_INBOX_IDS: readonly number[] = Object.freeze([4101, 4102]);

export const TENANT_SERVICE_NAME = 'elo-agendor-mcp' as const;
