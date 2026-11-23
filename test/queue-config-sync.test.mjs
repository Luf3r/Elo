import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const queueSource = readFileSync(new URL('../src/automation/execution/queue.ts', import.meta.url), 'utf8');
const wranglerExample = readFileSync(new URL('../wrangler.example.jsonc', import.meta.url), 'utf8');

test('QUEUE_MAX_RETRIES matches max_retries of every queue consumer in wrangler.example.jsonc', () => {
  const constant = queueSource.match(/export const QUEUE_MAX_RETRIES = (\d+);/);
  assert.ok(constant, 'src/automation/execution/queue.ts must export a numeric QUEUE_MAX_RETRIES');
  const consumers = [...wranglerExample.matchAll(/"max_retries":\s*(\d+)/g)].map((match) => Number(match[1]));
  assert.ok(consumers.length > 0, 'wrangler.example.jsonc must declare max_retries for its queue consumers');
  for (const value of consumers) assert.equal(value, Number(constant[1]));
});
