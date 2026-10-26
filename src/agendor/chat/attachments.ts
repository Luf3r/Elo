import { SafeError } from '../../errors';
import { throwIfCancelled } from '../../cancellation';
import type { AttachmentInput, AttachmentResult } from './types';

// No CDN origin is verified yet. Do not broaden this from a caller-supplied URL.
const ALLOWED_ATTACHMENT_ORIGINS = new Set(['https://chat.agendor.com.br']);
const MAX_BYTES = 5 * 1_048_576;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export interface AttachmentDownloadDependencies {
  request(request: Request): Promise<Response>;
  signal?: AbortSignal;
  maxBytes?: number;
}
/** Also bounds transports/streams that do not implement AbortSignal themselves. */
export async function awaitChatRead<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('Chat read cancelled.'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}export async function downloadAttachment(input: AttachmentInput, rawUrl: unknown, deps: AttachmentDownloadDependencies): Promise<AttachmentResult> {
  const unavailable = (reason: string): AttachmentResult => ({ ...input, status: 'unavailable', pending: true, reason });
  let url: URL;
  try { url = new URL(typeof rawUrl === 'string' ? rawUrl : ''); } catch { return unavailable('url_unavailable'); }
  if (!ALLOWED_ATTACHMENT_ORIGINS.has(url.origin) || url.protocol !== 'https:' || url.username || url.password || url.hash) return unavailable('origin_not_allowed');
  const configuredLimit = deps.maxBytes;
  const maxBytes = configuredLimit !== undefined && Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? Math.min(MAX_BYTES, configuredLimit) : MAX_BYTES;
  throwIfCancelled(deps.signal);
  const controller = new AbortController();
  const signal = deps.signal ? AbortSignal.any([controller.signal, deps.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    // Deliberately no Chat api_access_token or other credentials, even on the fixed origin.
    const response = await awaitChatRead(deps.request(new Request(url, { method: 'GET', redirect: 'manual', signal })), signal);
    if (!response.ok) {
      if (response.body) await awaitChatRead(response.body.cancel(), signal);
      return unavailable(response.status >= 300 && response.status < 400 ? 'redirect_not_allowed' : [401, 403, 404, 410].includes(response.status) ? 'url_expired_or_unavailable' : 'download_unavailable');
    }
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) { if (response.body) await awaitChatRead(response.body.cancel(), signal); return unavailable('size_limit'); }
    if (!mimeType || (mimeType !== 'text/plain' && !IMAGE_MIMES.has(mimeType))) {
      if (response.body) await awaitChatRead(response.body.cancel(), signal);
      return { ...unavailable('unsupported_format'), resource: { type: 'resource_link', uri: url.href, name: 'Chat attachment', ...(mimeType ? { mimeType } : {}) } };
    }
    if (!response.body) return unavailable('empty_attachment');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await awaitChatRead(reader.read(), signal);
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await awaitChatRead(reader.cancel(), signal); return unavailable('size_limit'); }
        chunks.push(value);
      }
    } finally {
      if (signal.aborted) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    if (mimeType === 'text/plain') {
      try { return { ...input, status: 'available', pending: false, mimeType, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }; }
      catch { return unavailable('unsupported_encoding'); }
    }
    let binary = '';
    for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    return { ...input, status: 'available', pending: false, mimeType, data: btoa(binary) };
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throwIfCancelled(deps.signal);
    return unavailable(controller.signal.aborted ? 'download_timeout' : 'download_unavailable');
  } finally { clearTimeout(timer); }
}
