import assert from 'node:assert/strict';

export const DEFAULT_SECRET_ENV_KEYS = [
  'ACCESS_CLIENT_SECRET',
  'AGENDOR_CRM_TOKEN',
  'AGENDOR_CHAT_TOKEN',
  'MCP_OAUTH_ACCESS_TOKEN',
] as const;

function normalizeSecrets(secrets: Iterable<string | undefined | null>): string[] {
  const unique = new Set<string>();
  for (const value of secrets) {
    if (typeof value === 'string' && value.length > 0) {
      unique.add(value);
    }
  }
  return [...unique].sort((a, b) => b.length - a.length);
}

/** Gather non-empty secret values from `env` and explicit extra credentials. */
export function collectKnownSecrets(
  extraSecrets: Iterable<string | undefined | null> = [],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const envSecrets = DEFAULT_SECRET_ENV_KEYS.map((key) => env[key]);
  return normalizeSecrets([...envSecrets, ...extraSecrets]);
}

/** Replace all occurrences of known secrets in `text` with `[REDACTED]`. */
export function redactSecrets(
  text: string,
  secrets: Iterable<string | undefined | null> = collectKnownSecrets(),
): string {
  let output = text;
  for (const secret of normalizeSecrets(secrets)) {
    output = output.split(secret).join('[REDACTED]');
  }
  return output;
}

/** Return true if any non-empty secret appears in `text`. */
export function containsSecret(text: string, secrets: Iterable<string | undefined | null>): boolean {
  return normalizeSecrets(secrets).some((secret) => text.includes(secret));
}

/** Fail closed when any non-empty secret appears in `text`. */
export function assertNoSecrets(
  text: string,
  secrets: Iterable<string | undefined | null>,
  errorMessage = 'RESULT_REDACTION_FAILED',
): void {
  assert(!containsSecret(text, secrets), errorMessage);
}
