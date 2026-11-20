import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareRelease } from '../scripts/release.ts';

const commit = 'a'.repeat(40);

test('prepareRelease rejects dirty working tree before running check or deploy', () => {
  let checkCalled = false;
  assert.throws(
    () =>
      prepareRelease({
        readPackageJson: () => ({ version: '0.1.7' }),
        runGit: (args) =>
          args[0] === 'status'
            ? { status: 0, stdout: ' M package.json\n', stderr: '' }
            : { status: 0, stdout: commit, stderr: '' },
        runCheck: () => {
          checkCalled = true;
          return { status: 0 };
        },
      }),
    /clean/,
  );
  assert.equal(checkCalled, false);
});

test('prepareRelease rejects missing or mismatched version tag before running check or deploy', () => {
  let checkCalled = false;
  assert.throws(
    () =>
      prepareRelease({
        readPackageJson: () => ({ version: '0.1.7' }),
        runGit: (args) => {
          if (args[0] === 'status') return { status: 0, stdout: '', stderr: '' };
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { status: 0, stdout: `${commit}\n`, stderr: '' };
          return { status: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' };
        },
        runCheck: () => {
          checkCalled = true;
          return { status: 0 };
        },
      }),
    /v0\.1\.7/,
  );
  assert.equal(checkCalled, false);
});

test('prepareRelease fails when npm run check fails without returning a deploy command', () => {
  assert.throws(
    () =>
      prepareRelease({
        readPackageJson: () => ({ version: '0.1.7' }),
        runGit: (args) =>
          args[0] === 'status'
            ? { status: 0, stdout: '', stderr: '' }
            : { status: 0, stdout: `${commit}\n`, stderr: '' },
        runCheck: () => ({ status: 1 }),
      }),
    /npm run check failed/,
  );
});

test('prepareRelease runs check and returns deploy command with version and commit without deploying', () => {
  const gitCalls = [];
  let checkCalls = 0;
  const result = prepareRelease({
    readPackageJson: () => ({ version: '0.1.7' }),
    runGit: (args) => {
      gitCalls.push(args.join(' '));
      if (args[0] === 'status') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: `${commit}\n`, stderr: '' };
    },
    runCheck: () => {
      checkCalls++;
      return { status: 0 };
    },
  });
  assert.equal(checkCalls, 1);
  assert.equal(
    gitCalls.some((c) => c.includes('wrangler')),
    false,
  );
  assert.match(result.deployCommand, /^npx wrangler deploy /);
  assert.match(result.deployCommand, /--message "Release v0\.1\.7 \(a{40}\)"/);
  assert.match(result.deployCommand, /--tag v0\.1\.7/);
  assert.match(result.deployCommand, /__BUILD_COMMIT__/);
  assert.match(result.deployCommand, /--env=""/);
  assert.match(result.stagingCommand, /^npx wrangler deploy --env staging /);
  assert.match(result.stagingCommand, /__BUILD_COMMIT__/);
  assert.match(result.uploadCommand, /^npx wrangler versions upload --env="" /);
  assert.match(result.uploadCommand, /--tag v0\.1\.7/);
  assert.deepEqual(
    result.rolloutCommands.map((command) => command.match(/@(\d+)%/)?.[1]),
    ['10', '50', '100'],
  );
  for (const command of result.rolloutCommands) assert.match(command, /^npx wrangler versions deploy --env="" /);
});
