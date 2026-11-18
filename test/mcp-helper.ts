import worker from '../src/index';
import { context, testEnv } from './helpers';
import type { Env } from '../src/env';
import { issueTestToken } from './oauth-token';
import { RESOURCE, ORIGIN } from '../src/oauth/config';

export async function rpc(
  method: string,
  params: Record<string, unknown> = {},
  env: Env = testEnv(),
  extraHeaders: Record<string, string> = {},
  scopes = ['crm:read', 'offline_access'],
) {
  const token = await issueTestToken(env, undefined, scopes);
  const response = await worker.fetch(
    new Request(RESOURCE, {
      method: 'POST',
      headers: {
        Host: new URL(ORIGIN).host,
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-11-25',
        ...extraHeaders,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    env,
    context(),
  );
  const text = await response.text();
  const data = response.headers.get('Content-Type')?.includes('text/event-stream')
    ? JSON.parse(
        text
          .split('\n')
          .find((line) => line.startsWith('data: '))!
          .slice(6),
      )
    : JSON.parse(text);
  return { response, data };
}
export const callTool = (name: string, args: Record<string, unknown> = {}, env?: Env, scopes?: string[]) =>
  rpc('tools/call', { name, arguments: args }, env, {}, scopes);
