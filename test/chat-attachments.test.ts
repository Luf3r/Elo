import { allowBudget } from './helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgendorChatClient } from '../src/agendor/chat/client';
beforeEach(() => vi.stubGlobal('fetch', () => { throw new Error('Network blocked by synthetic fixture'); }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const env = { AGENDOR_CHAT_TOKEN: 'synthetic-token', AGENDOR_CHAT_ACCOUNT_ID: '100' };
function attachmentClient(url: string, response: () => Response, maxAttachmentBytes?: number) {
  let downloads = 0;
  const client = createAgendorChatClient(env, { budgetGate: allowBudget, maxAttachmentBytes, request: async request => {
    if (request.url.endsWith('/attachments')) return Response.json({ payload: [{ id: 400, data_url: url, file_type: 'file' }] });
    downloads++;
    expect(request.headers.has('api_access_token')).toBe(false);
    expect(request.redirect).toBe('manual');
    return response();
  } });
  return { client, count: () => downloads };
}
describe('authorized Chat attachments', () => {
  it('rejects untrusted origins before network access and never takes a caller URL', async () => {
    const { client, count } = attachmentClient('https://cdn.example.invalid/private', () => new Response('SYNTHETIC'));
    const result = await client.readAttachment({ conversationId: 200, attachmentId: 400 });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'origin_not_allowed', pending: true });
    expect(count()).toBe(0);
    await expect(client.readAttachment({ conversationId: 200, attachmentId: 400, url: 'https://example.invalid' } as never)).rejects.toBeDefined();
  });
  it.each([302, 403, 404, 410])('returns sanitized unavailable result for redirect or expired URL (%s)', async status => {
    const { client, count } = attachmentClient('https://chat.agendor.com.br/files/synthetic', () => new Response('PRIVATE', { status, headers: { location: 'https://example.invalid' } }));
    const result = await client.readAttachment({ conversationId: 200, attachmentId: 400 });
    expect(result.status).toBe('unavailable');
    expect(result.pending).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(count()).toBe(1);
  });
  it('enforces the smaller client byte limit during streaming', async () => {
    const { client } = attachmentClient('https://chat.agendor.com.br/files/synthetic', () => new Response(new Uint8Array(33), { headers: { 'content-type': 'text/plain' } }), 32);
    expect(await client.readAttachment({ conversationId: 200, attachmentId: 400 })).toMatchObject({ reason: 'size_limit', pending: true });
  });
  it('returns supported text and images without Chat credentials on the download', async () => {
    for (const mime of ['text/plain', 'image/png']) {
      const { client } = attachmentClient('https://chat.agendor.com.br/files/synthetic', () => new Response('SYNTHETIC', { headers: { 'content-type': mime } }));
      expect(await client.readAttachment({ conversationId: 200, attachmentId: 400 })).toMatchObject({ status: 'available', mimeType: mime, pending: false });
    }
  });
  it('returns an authorized link and pending reason for unsupported formats', async () => {
    const { client } = attachmentClient('https://chat.agendor.com.br/files/synthetic', () => new Response('SYNTHETIC', { headers: { 'content-type': 'application/pdf' } }));
    expect(await client.readAttachment({ conversationId: 200, attachmentId: 400 })).toMatchObject({ reason: 'unsupported_format', pending: true, resource: { type: 'resource_link', uri: 'https://chat.agendor.com.br/files/synthetic' } });
  });
  it('only downloads an attachment present in the authorized conversation list', async () => {
    const { client, count } = attachmentClient('https://chat.agendor.com.br/files/synthetic', () => new Response('SYNTHETIC'));
    expect(await client.readAttachment({ conversationId: 200, attachmentId: 401 })).toMatchObject({ reason: 'attachment_not_found' });
    expect(count()).toBe(0);
  });
  it('enforces the hard five MiB cap even if the client limit is larger', async () => {
    const { client } = attachmentClient('https://chat.agendor.com.br/files/synthetic', () => new Response(new Uint8Array(5 * 1_048_576 + 1), { headers: { 'content-type': 'image/png' } }), 10 * 1_048_576);
    expect(await client.readAttachment({ conversationId: 200, attachmentId: 400 })).toMatchObject({ reason: 'size_limit' });
  });
  it('bounds attachment JSON metadata to one MiB before parsing', async () => {
    const client = createAgendorChatClient(env, { budgetGate: allowBudget, request: async () => new Response(' '.repeat(1_048_577)) });
    await expect(client.listAttachments(200)).rejects.toMatchObject({ code: 'UPSTREAM_INVALID_RESPONSE' });
  });
  it('rejects credential-bearing URLs and malformed or missing authorization metadata', async () => {
    const { client, count } = attachmentClient('https://user:pass@chat.agendor.com.br/files/synthetic', () => new Response('SYNTHETIC'));
    expect(await client.readAttachment({ conversationId: 200, attachmentId: 400 })).toMatchObject({ reason: 'origin_not_allowed' });
    expect(count()).toBe(0);
  });
  it('does not download when attachment metadata contradicts the conversation ID', async () => {
    const client = createAgendorChatClient(env, { budgetGate: allowBudget, request: async request => {
      if (!request.url.endsWith('/attachments')) throw new Error('Unexpected synthetic download');
      return Response.json({ payload: [{ id: 400, conversation_id: 201, data_url: 'https://chat.agendor.com.br/files/synthetic' }] });
    } });
    expect(await client.readAttachment({ conversationId: 200, attachmentId: 400 })).toMatchObject({ status: 'unavailable', reason: 'attachment_identity_mismatch' });
  });
  it('times out a stalled attachment body and releases the reader', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const { client } = attachmentClient('https://chat.agendor.com.br/files/synthetic', () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/plain' } }));
    const result = client.readAttachment({ conversationId: 200, attachmentId: 400 });
    await vi.advanceTimersByTimeAsync(10_001);
    const outcome = await Promise.race([result, Promise.resolve('still_pending')]);
    expect(outcome).toMatchObject({ status: 'unavailable', reason: 'download_timeout', pending: true });
    expect(cancelled).toBe(true);
  });
  it('times out stalled attachment metadata without exposing its body', async () => {
    vi.useFakeTimers();
    const client = createAgendorChatClient(env, { budgetGate: allowBudget, request: async () => new Response(new ReadableStream()) });
    const result = client.listAttachments(200).catch(error => error);
    await vi.advanceTimersByTimeAsync(10_001);
    const outcome = await Promise.race([result, Promise.resolve('still_pending')]);
    expect(outcome).toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
  });
});
