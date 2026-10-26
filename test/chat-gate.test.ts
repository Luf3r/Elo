import { expect, it, vi } from 'vitest';
import { callTool, rpc } from './mcp-helper';
import { testEnv } from './helpers';

it('keeps Chat tools disabled even when a Chat token is supplied', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const { data } = await rpc('tools/list', {}, testEnv({ AGENDOR_CHAT_TOKEN: 'unverified-token' }));
  expect(data.result.tools.some((t: { name: string }) => t.name.startsWith('chat_'))).toBe(false);
  expect(data.result.tools.filter((t: { name: string }) => t.name.startsWith('crm_')).map((t: { name: string }) => t.name).sort()).toEqual([
    'crm_find_person_by_email', 'crm_get_configuration', 'crm_get_deal', 'crm_get_organization', 'crm_get_person', 'crm_get_task',
    'crm_list_tasks', 'crm_search_deals', 'crm_search_organizations', 'crm_search_people',
    'crm_update_deal', 'crm_update_deal_stage', 'crm_update_organization', 'crm_update_person',
  ].sort());
  expect(fetch).not.toHaveBeenCalled();
});
it('refuses unverified Chat calls without issuing network traffic', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const { data } = await callTool('chat_list_messages', { conversationId: 'unverified' });
  expect(Boolean(data.error || data.result?.isError)).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
