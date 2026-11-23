import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const documentationFiles = [];

function collectMarkdownFiles(directory, recursive) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filePath = join(directory, entry.name);

    if (entry.isDirectory() && recursive) {
      collectMarkdownFiles(filePath, true);
    } else if (entry.isFile() && filePath.endsWith('.md')) {
      documentationFiles.push(filePath);
    }
  }
}

collectMarkdownFiles('docs', false);
for (const directory of ['docs/operations', 'docs/integrations', 'docs/decisions']) {
  collectMarkdownFiles(directory, true);
}

test('current documentation avoids deployment-specific example wording', () => {
  assert.ok(documentationFiles.length > 0, 'Expected current documentation files to be checked');

  for (const filePath of documentationFiles) {
    const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);

    lines.forEach((line, index) => {
      assert.ok(!line.includes('nesta implantação'), `${filePath}:${index + 1} contains "nesta implantação"`);
      assert.ok(!line.includes("getByName('"), `${filePath}:${index + 1} contains "getByName('"`);
    });
  }
});
