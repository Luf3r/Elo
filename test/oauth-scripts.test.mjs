import { test } from 'node:test';
import assert from 'node:assert/strict';
import { origin, validateMcpTarget } from '../scripts/lib/oauth-session.ts';
test('credentials cannot be sent to another remote MCP host or a URL carrying query credentials', () => {
  for (const target of [
    'https://other.workers.dev/mcp',
    'https://evil.example/mcp',
    `https://user:secret@${new URL(origin).host}/mcp`,
    `${origin}/mcp?token=x`,
  ])
    assert.throws(() => validateMcpTarget(target));
  assert.equal(validateMcpTarget(`${origin}/mcp`).pathname, '/mcp');
});
