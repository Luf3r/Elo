import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT_DIR = resolve(import.meta.dirname, '../..');

/**
 * The real deployment config (wrangler.jsonc) is local and ignored by Git.
 * Without it (CI, fresh clones) scripts fall back to the versioned example.
 */
export function wranglerConfigPath(): string {
  const local = resolve(ROOT_DIR, 'wrangler.jsonc');
  return existsSync(local) ? local : resolve(ROOT_DIR, 'wrangler.example.jsonc');
}
