import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateMcpTarget} from '../scripts/oauth-session.mjs';
test('credentials cannot be sent to another remote MCP host or a URL carrying query credentials',()=>{
  for(const target of ['https://other.workers.dev/mcp','https://evil.example/mcp','https://user:secret@elo-agendor-mcp.example.workers.dev/mcp','https://elo-agendor-mcp.example.workers.dev/mcp?token=x'])assert.throws(()=>validateMcpTarget(target));
  assert.equal(validateMcpTarget('https://elo-agendor-mcp.example.workers.dev/mcp').pathname,'/mcp');
});
