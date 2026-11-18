import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntrypoint, parseCliArgs, parseEnvVars } from '../scripts/lib/args.ts';
import { assertNoSecrets, collectKnownSecrets, containsSecret, redactSecrets } from '../scripts/lib/redaction.ts';

function collectScriptTsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectScriptTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

test('scripts/ contains no .mjs files and importing every .ts script performs no network calls', async () => {
  const scriptsDir = resolve('scripts');
  const entries = readdirSync(scriptsDir, { recursive: true, encoding: 'utf8' });
  assert.deepEqual(
    entries.filter((entry) => entry.endsWith('.mjs')),
    [],
    'No .mjs files may remain in scripts/.',
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('NETWORK_CALL_ON_IMPORT');
  };
  try {
    const files = collectScriptTsFiles(scriptsDir);
    assert.ok(files.length >= 16);
    for (const file of files) {
      await import(pathToFileURL(file).href);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('redaction helper collects, detects, asserts, and redacts secrets', () => {
  const secrets = collectKnownSecrets(['runtime-token', 'short'], {
    ACCESS_CLIENT_SECRET: 'access-secret-value',
    AGENDOR_CRM_TOKEN: 'crm-secret-value',
  });
  assert.deepEqual(secrets, ['access-secret-value', 'crm-secret-value', 'runtime-token', 'short']);
  assert.equal(containsSecret('contains crm-secret-value inside', secrets), true);
  assert.equal(containsSecret('clean text', secrets), false);
  assert.equal(redactSecrets('token=runtime-token and crm-secret-value', secrets), 'token=[REDACTED] and [REDACTED]');
  assert.throws(() => assertNoSecrets('leak runtime-token', secrets), /RESULT_REDACTION_FAILED/);
  assert.doesNotThrow(() => assertNoSecrets('safe output', secrets));
});

test('args helper parses flags/options strictly and parses .dev.vars lines', () => {
  const parsed = parseCliArgs(['--read', '--conversation', '42'], {
    flags: ['--read', '--write'],
    options: ['--conversation'],
  });
  assert.equal(parsed.flags.has('--read'), true);
  assert.equal(parsed.flags.has('--write'), false);
  assert.equal(parsed.values.get('--conversation'), '42');

  assert.throws(() => parseCliArgs(['--unknown'], { flags: ['--read'] }), /Unknown option/);
  assert.throws(() => parseCliArgs(['--conversation'], { options: ['--conversation'] }), /Option requires a value/);
  assert.throws(
    () => parseCliArgs(['--conversation', '--read'], { flags: ['--read'], options: ['--conversation'] }),
    /Option requires a value/,
  );

  const vars = parseEnvVars('AGENDOR_CHAT_TOKEN="tok-1"\nAGENDOR_CHAT_ACCOUNT_ID=\'7001\'\n# comment\nEMPTY=\n');
  assert.equal(vars.get('AGENDOR_CHAT_TOKEN'), 'tok-1');
  assert.equal(vars.get('AGENDOR_CHAT_ACCOUNT_ID'), '7001');
  assert.equal(vars.get('EMPTY'), '');
  assert.equal(isEntrypoint('file:///definitely-not-entrypoint.ts'), false);
});
