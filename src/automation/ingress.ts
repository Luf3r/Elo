import type { Env } from '../env';
import { z } from 'zod';
import { EXPECTED_CHAT_ACCOUNT_ID } from '../app/config/tenant';
import { accountState } from './state/budget';
import { payloadDigest } from './operations';
const hintSchema = z.strictObject({
  eventId: z.string().min(1).max(200),
  accountId: z.string().min(1).max(200),
  conversationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const MAX_HINT_BYTES = 8192;
/** Optional, deliberately enabled, unsigned review hint endpoint. No message
 * content is accepted and no upstream fact can be derived from this envelope. */
export async function acceptChatHint(request: Request, env: Env): Promise<Response> {
  if (env.AUTOMATION_CHAT_HINTS_ENABLED !== 'true' || env.AGENDOR_CHAT_ACCOUNT_ID !== EXPECTED_CHAT_ACCOUNT_ID)
    return new Response(null, { status: 404 });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  if (request.headers.get('Content-Type')?.split(';')[0]?.trim() !== 'application/json')
    return new Response(null, { status: 415 });
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_HINT_BYTES) return new Response(null, { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_HINT_BYTES) {
        await reader.cancel();
        return new Response(null, { status: 413 });
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed = hintSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!parsed.success || parsed.data.accountId !== EXPECTED_CHAT_ACCOUNT_ID)
      return new Response(null, { status: 400 });
    const fingerprint = await payloadDigest(parsed.data);
    const key = await payloadDigest({ accountId: parsed.data.accountId, eventId: parsed.data.eventId });
    const result = await accountState(env).recordChatHint(key, fingerprint, parsed.data.conversationId, Date.now());
    return Response.json(
      { state: result, requiresCanonicalRead: true },
      {
        status: result === 'limited' ? 429 : result === 'conflict' ? 409 : 202,
        headers: { 'Cache-Control': 'no-store', ...(result === 'limited' ? { 'Retry-After': '60' } : {}) },
      },
    );
  } catch (error) {
    return new Response(null, { status: error instanceof SyntaxError ? 400 : 503 });
  } finally {
    reader.releaseLock();
  }
}
