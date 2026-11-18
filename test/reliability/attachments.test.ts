import { describe, expect, it } from 'vitest';
import { downloadAttachment } from '../../src/agendor/chat/attachments';
const input = { conversationId: 42, attachmentId: 1 };
const origin = 'https://chat.agendor.com.br';
describe('safe attachment download', () => {
  it('follows a same-origin redirect manually without forwarding credentials', async () => {
    const paths: string[] = [];
    const result = await downloadAttachment(input, origin + '/initial', {
      request: async (req) => {
        expect(req.redirect).toBe('manual');
        expect([...req.headers]).toEqual([]);
        paths.push(new URL(req.url).pathname);
        return paths.length === 1
          ? new Response(null, { status: 302, headers: { location: '/final' } })
          : new Response('PDF', { headers: { 'content-type': 'application/pdf' } });
      },
    });
    expect(paths).toEqual(['/initial', '/final']);
    expect(result).toMatchObject({ status: 'available', mimeType: 'application/pdf', data: 'UERG' });
  });
  it('rejects a private redirect before requesting the destination', async () => {
    let calls = 0;
    const result = await downloadAttachment(input, origin + '/initial', {
      request: async () => {
        calls++;
        return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } });
      },
    });
    expect(calls).toBe(1);
    expect(result.reason).toBe('redirect_origin_not_allowed');
  });
  it('allows three redirects but never a fourth', async () => {
    let calls = 0;
    const result = await downloadAttachment(input, origin + '/0', {
      request: async () => new Response(null, { status: 302, headers: { location: '/' + ++calls } }),
    });
    expect(calls).toBe(4);
    expect(result.reason).toBe('redirect_limit');
  });
  it('returns bounded content parts for a file larger than one MCP output', async () => {
    const bytes = new Uint8Array(600_000).fill(65);
    const request = async () => new Response(bytes, { headers: { 'content-type': 'audio/ogg' } });
    const first = await downloadAttachment(input, origin + '/audio', { request });
    expect(first).toMatchObject({ status: 'available', totalBytes: 600000, offset: 0, nextOffset: 196608 });
    expect(first.data!.length).toBeLessThan(300000);
    const next = await downloadAttachment(
      { ...input, offset: first.nextOffset!, expectedSha256: first.sha256 },
      origin + '/audio',
      { request },
    );
    expect(next.offset).toBe(196608);
    expect(next.sha256).toBe(first.sha256);
  });
  it('rejects files over twenty MiB before reading their body', async () => {
    const result = await downloadAttachment(input, origin + '/big', {
      request: async () =>
        new Response('tiny', { headers: { 'content-type': 'text/plain', 'content-length': String(20 * 1048576 + 1) } }),
    });
    expect(result.reason).toBe('size_limit');
  });
});
