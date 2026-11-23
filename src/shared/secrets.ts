export function isConfiguredSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/\s/.test(value) && value !== 'replace-me';
}
