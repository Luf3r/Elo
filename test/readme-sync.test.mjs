import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const agents = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');

test('README.md reports the package version from package.json', () => {
  assert.ok(
    readme.includes(`- **Versão do pacote:** \`${packageJson.version}\``),
    `README.md must report package version ${packageJson.version} in the package version line`,
  );
});

test('README.md and AGENTS.md mention every npm run step from scripts.check', () => {
  const checkSteps = packageJson.scripts.check.match(/npm run ([\w:-]+)/g) ?? [];

  for (const step of checkSteps) {
    assert.ok(readme.includes(step), `README.md must mention ${step}`);
    assert.ok(agents.includes(step), `AGENTS.md must mention ${step}`);
  }
});
