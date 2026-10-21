import worker from '../src/index';
import { context, testEnv } from './helpers';
import type { Env } from '../src/env';

export async function rpc(method: string, params: Record<string, unknown> = {}, env: Env = testEnv(), extraHeaders: Record<string, string> = {}) {
  const response = await worker.fetch(new Request('https://localhost/mcp', {
    method: 'POST',
    headers: { Host: 'localhost', Authorization: 'Bearer unit-mcp-token', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25', ...extraHeaders },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }), env, context());
  const text = await response.text();
  const data = response.headers.get('Content-Type')?.includes('text/event-stream')
    ? JSON.parse(text.split('\n').find(line => line.startsWith('data: '))!.slice(6))
    : JSON.parse(text);
  return { response, data };
}
export const callTool = (name: string, args: Record<string, unknown> = {}, env?: Env) => rpc('tools/call', { name, arguments: args }, env);
