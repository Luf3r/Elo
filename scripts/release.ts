import { spawnSync } from 'node:child_process';
import { isEntrypoint, readJsonFile } from './lib/args.ts';

export interface GitCommandResult {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
}

export interface CheckCommandResult {
  status: number | null;
}

export interface PackageMetadata {
  version?: string;
}

export interface ReleaseDeps {
  readPackageJson: () => PackageMetadata;
  runGit: (args: string[]) => GitCommandResult;
  runCheck: () => CheckCommandResult;
}

export interface ReleasePlan {
  version: string;
  tag: string;
  commit: string;
  deployCommand: string;
}

const DEFAULT_DEPS: ReleaseDeps = {
  readPackageJson: () => readJsonFile<PackageMetadata>('package.json'),
  runGit: (args) => spawnSync('git', args, { encoding: 'utf8' }),
  runCheck: () =>
    spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'check'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    }),
};

/**
 * Validate release preconditions (clean git tree, passing `npm run check`, and
 * matching `vX.Y.Z` tag on `HEAD`) and format the `wrangler deploy` command.
 * Never executes a deployment.
 */
export function prepareRelease(deps: ReleaseDeps = DEFAULT_DEPS): ReleasePlan {
  const pkg = deps.readPackageJson();
  const version = pkg.version;
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`package.json version must be X.Y.Z; got ${JSON.stringify(version)}.`);
  }
  const tag = `v${version}`;

  const status = deps.runGit(['status', '--porcelain']);
  if (status.status !== 0) {
    throw new Error(`Failed to inspect git working tree: ${status.stderr?.trim() || 'git status failed'}`);
  }
  if ((status.stdout ?? '').trim().length > 0) {
    throw new Error('Git working tree must be clean before preparing a release.');
  }

  const head = deps.runGit(['rev-parse', 'HEAD']);
  const commit = (head.stdout ?? '').trim();
  if (head.status !== 0 || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`Failed to resolve HEAD commit hash: ${head.stderr?.trim() || commit}`);
  }

  const tagRef = deps.runGit(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]);
  const tagCommit = (tagRef.stdout ?? '').trim();
  if (tagRef.status !== 0 || tagCommit !== commit) {
    throw new Error(`Tag ${tag} must exist and point to HEAD (${commit}).`);
  }

  const check = deps.runCheck();
  if (check.status !== 0) {
    throw new Error(`npm run check failed with status ${check.status ?? 1}.`);
  }

  const defineArg =
    process.platform === 'win32' ? `'__BUILD_COMMIT__:\\"${commit}\\"'` : `'__BUILD_COMMIT__:"${commit}"'`;
  const deployCommand = `npx wrangler deploy --define ${defineArg} --tag ${tag} --message "Release ${tag} (${commit})"`;
  return { version, tag, commit, deployCommand };
}

if (isEntrypoint(import.meta.url)) {
  try {
    const result = prepareRelease();
    console.log('Release checks passed. Run the following command manually to deploy:');
    console.log(result.deployCommand);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
