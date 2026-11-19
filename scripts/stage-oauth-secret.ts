import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isEntrypoint, loadLocalDevVars, readJsoncFile } from './lib/args.ts';
import { collectKnownSecrets, redactSecrets } from './lib/redaction.ts';

interface WranglerConfig {
  name?: string;
  vars?: {
    ACCESS_CLIENT_ID?: string;
  };
}

/** Stage `ACCESS_CLIENT_SECRET` via Wrangler stdin without exposing secrets in argv or output. */
export function stageOauthSecret(): number {
  loadLocalDevVars();
  const config = readJsoncFile<WranglerConfig>('wrangler.jsonc');
  assert(typeof config.name === 'string' && config.name.trim().length > 0, 'Missing Worker name in wrangler.jsonc.');
  assert.equal(config.vars?.ACCESS_CLIENT_ID, 'example-client-id');
  const value = process.env.ACCESS_CLIENT_SECRET;
  assert(
    value && value !== 'replace-me' && value.length >= 24 && !/\s/.test(value),
    'Configure ACCESS_CLIENT_SECRET locally; do not paste it in chat.',
  );
  // Stages a version, preserving deployed code/traffic. The subsequent code upload inherits the latest version's secret.
  const child = spawnSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'versions',
      'secret',
      'bulk',
      '--name',
      config.name,
      '--message',
      'Stage Access OIDC secret for OAuth',
    ],
    {
      input: JSON.stringify({ ACCESS_CLIENT_SECRET: value }),
      encoding: 'utf8',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    },
  );
  const output = redactSecrets(String(child.stdout ?? '') + String(child.stderr ?? ''), collectKnownSecrets([value]));
  process.stdout.write(output);
  return child.status ?? 1;
}

if (isEntrypoint(import.meta.url)) {
  try {
    process.exitCode = stageOauthSecret();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
