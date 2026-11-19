import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { isEntrypoint } from './lib/args.ts';
import { wranglerConfigPath } from './lib/wrangler-config.ts';

/** Bundle the Worker without deploying, using the local config or the versioned example. */
export function buildDryRun(): number {
  const wrangler = resolve(import.meta.dirname, '../node_modules/wrangler/bin/wrangler.js');
  const result = spawnSync(
    process.execPath,
    [wrangler, 'deploy', '--dry-run', '--outdir', 'dist', '--config', wranglerConfigPath()],
    { stdio: 'inherit' },
  );
  return result.status ?? 1;
}

if (isEntrypoint(import.meta.url)) process.exitCode = buildDryRun();
