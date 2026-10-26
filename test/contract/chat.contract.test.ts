import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { createAgendorChatClient } from '../../src/agendor/chat/client';
import { isConfiguredSecret } from '../../src/auth';

const bindings = env as unknown as { AGENDOR_CHAT_TOKEN?: string; AGENDOR_CHAT_ACCOUNT_ID?: string; RUN_AGENDOR_CHAT_CONTRACT_TESTS?: string };
const enabled = isConfiguredSecret(bindings.AGENDOR_CHAT_TOKEN)
  && /^\d{1,20}$/.test(bindings.AGENDOR_CHAT_ACCOUNT_ID ?? '');
const client = enabled ? createAgendorChatClient({
  AGENDOR_CHAT_TOKEN: bindings.AGENDOR_CHAT_TOKEN ?? '',
  AGENDOR_CHAT_ACCOUNT_ID: bindings.AGENDOR_CHAT_ACCOUNT_ID ?? '',
}) : null;
const pause = () => new Promise(resolve => setTimeout(resolve, 350));
async function read<T>(operation: () => Promise<T>): Promise<T> { await pause(); return operation(); }

describe.skipIf(!enabled).sequential('read-only Agendor Chat contract (response values are never logged)', () => {
  it('reads the configured account conversation page', async () => {
    const result = await read(() => client!.listConversations()) as { conversations: unknown[]; counts: Record<string, number> };
    expect(Array.isArray(result.conversations)).toBe(true);
    expect(result.conversations.length).toBeLessThanOrEqual(25);
    expect(Object.values(result.counts).every(value => Number.isInteger(value) && value >= 0)).toBe(true);
  });
  it('reads detail and one default page of messages when a conversation exists', async context => {
    const result = await read(() => client!.listConversations()) as { conversations: Array<{ id: number }> };
    if (!result.conversations.length) { context.skip(); return; }
    const id = result.conversations[0]!.id;
    const detail = await read(() => client!.getConversation(id)) as { id: number };
    expect(detail.id).toBe(id);
    const messages = await read(() => client!.listMessages(id)) as { conversationId: number; messages: unknown[] };
    expect(messages.conversationId).toBe(id);
    expect(messages.messages.length).toBeLessThanOrEqual(20);
  });
});