import { spawnSync } from 'node:child_process';
import { isEntrypoint, loadLocalDevVars } from './lib/args.ts';

/** Execute the opt-in Agendor contract test suite using local `.dev.vars` when available. */
export function runContractTests(): number {
  loadLocalDevVars();
  process.env.RUN_AGENDOR_CONTRACT_TESTS = '1';
  const child = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'test/contract'], {
    stdio: 'inherit',
    env: process.env,
  });
  return child.status ?? 1;
}

if (isEntrypoint(import.meta.url)) {
  process.exitCode = runContractTests();
}
