import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

if (existsSync('.dev.vars')) process.loadEnvFile('.dev.vars');
process.env.RUN_AGENDOR_CONTRACT_TESTS = '1';
const child = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'test/contract'], {
  stdio: 'inherit', env: process.env,
});
process.exitCode = child.status ?? 1;
