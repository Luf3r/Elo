import { expect, it, vi } from 'vitest';
import { callTool, rpc } from './mcp-helper';
import { testEnv } from './helpers';

it('keeps Chat tools disabled even when a Chat token is supplied', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const { data } = await rpc('tools/list', {}, testEnv({ AGENDOR_CHAT_TOKEN: 'unverified-token' }));
  expect(data.result.tools.some((t: { name: string }) => t.name.startsWith('chat_'))).toBe(false);
  expect(data.result.tools.filter((t: { name: string }) => t.name.startsWith('crm_'))).toHaveLength(7);
  expect(fetch).not.toHaveBeenCalled();
});
it('refuses unverified Chat calls without issuing network traffic', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const { data } = await callTool('chat_list_messages', { conversationId: 'unverified' });
  expect(Boolean(data.error || data.result?.isError)).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
