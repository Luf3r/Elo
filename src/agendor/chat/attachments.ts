import { SafeError } from '../../shared/errors';
import { throwIfCancelled } from '../../shared/cancellation';
import { readBoundedBody } from '../../shared/bounded-body';
import type { AttachmentInput, AttachmentResult } from './types';

// Add a CDN only after recording its exact host from an authorized observation.
// Cloudflare global fetch uses public egress (global_fetch_strictly_public in Wrangler),
// never a private service binding or a preflight DNS lookup followed by an unpinned connection.
export const allowedAttachmentOrigins: readonly string[] = Object.freeze([
  'https://chat.agendor.com.br',
  'https://agendor-chat-sa-production.s3.sa-east-1.amazonaws.com',
]);
const MAX_BYTES = 20 * 1_048_576;
const PART_BYTES = 192 * 1024;
const MIMES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'text/plain',
]);
export interface AttachmentDownloadDependencies {
  request(request: Request): Promise<Response>;
  signal?: AbortSignal;
  maxBytes?: number;
}
function permitted(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    !url.port &&
    !url.username &&
    !url.password &&
    !url.hash &&
    allowedAttachmentOrigins.includes(url.origin)
  );
}
/** Also bounds transports/streams that do not implement AbortSignal themselves. */
export async function awaitChatRead<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('Chat read cancelled.'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export async function downloadAttachment(
  input: AttachmentInput,
  rawUrl: unknown,
  deps: AttachmentDownloadDependencies,
): Promise<AttachmentResult> {
  const identity = { conversationId: input.conversationId, attachmentId: input.attachmentId };
  const unavailable = (reason: string): AttachmentResult => ({
    ...identity,
    status: 'unavailable',
    pending: true,
    reason,
  });
  let url: URL;
  try {
    url = new URL(typeof rawUrl === 'string' ? rawUrl : '');
  } catch {
    return unavailable('url_unavailable');
  }
  if (!permitted(url)) return { ...unavailable('origin_not_allowed'), blockedHost: url.hostname };
  const configured = deps.maxBytes;
  const maxBytes =
    configured !== undefined && Number.isSafeInteger(configured) && configured > 0
      ? Math.min(configured, MAX_BYTES)
      : MAX_BYTES;
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && !/^[a-f0-9]{64}$/.test(input.expectedSha256 ?? '')))
    return unavailable('invalid_content_cursor');
  throwIfCancelled(deps.signal);
  const controller = new AbortController();
  const signal = deps.signal ? AbortSignal.any([deps.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    let response: Response;
    for (let redirects = 0; ; redirects++) {
      response = await awaitChatRead(
        deps.request(new Request(url, { method: 'GET', redirect: 'manual', signal })),
        signal,
      );
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      if (response.body) await awaitChatRead(response.body.cancel(), signal);
      if (redirects >= 3) return unavailable('redirect_limit');
      if (!location) return unavailable('redirect_location_unavailable');
      let destination: URL;
      try {
        destination = new URL(location, url);
      } catch {
        return unavailable('redirect_location_invalid');
      }
      if (!permitted(destination))
        return { ...unavailable('redirect_origin_not_allowed'), blockedHost: destination.hostname };
      url = destination;
    }
    if (!response.ok) {
      if (response.body) await awaitChatRead(response.body.cancel(), signal);
      return unavailable(
        [401, 403, 404, 410].includes(response.status) ? 'url_expired_or_unavailable' : 'download_unavailable',
      );
    }
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
      if (response.body) await awaitChatRead(response.body.cancel(), signal);
      return unavailable('size_limit');
    }
    if (!mimeType || !MIMES.has(mimeType)) {
      if (response.body) await awaitChatRead(response.body.cancel(), signal);
      return unavailable('unsupported_format');
    }
    if (!response.body) return unavailable('empty_attachment');
    const result = await readBoundedBody(response.body, maxBytes, {
      race: (promise) => awaitChatRead(promise, signal),
      awaitCancel: true,
      signal,
    });
    if (result.kind === 'non_binary') return unavailable('download_unavailable');
    if (result.kind === 'too_large') return unavailable('size_limit');
    const bytes = result.bytes;
    const size = bytes.byteLength;
    if (size === 0) return unavailable('empty_attachment');
    if (offset >= size) return unavailable('invalid_content_cursor');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (input.expectedSha256 && input.expectedSha256 !== sha256) return unavailable('attachment_changed');
    const part = bytes.subarray(offset, Math.min(offset + PART_BYTES, size));
    const nextOffset = offset + part.length < size ? offset + part.length : null;
    const metadata = {
      ...identity,
      status: 'available' as const,
      pending: false,
      mimeType,
      totalBytes: size,
      offset,
      nextOffset,
      sha256,
      contentComplete: offset === 0 && nextOffset === null,
    };
    if (mimeType === 'text/plain' && size <= 32_768 && offset === 0) {
      try {
        return { ...metadata, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) };
      } catch {
        return unavailable('unsupported_encoding');
      }
    }
    let binary = '';
    for (let start = 0; start < part.length; start += 8192)
      binary += String.fromCharCode(...part.subarray(start, start + 8192));
    return { ...metadata, data: btoa(binary) };
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throwIfCancelled(deps.signal);
    return unavailable(controller.signal.aborted ? 'download_timeout' : 'download_unavailable');
  } finally {
    clearTimeout(timer);
  }
}
