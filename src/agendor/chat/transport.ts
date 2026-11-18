import type { BudgetGate } from '../ports';
import { SafeError, type ErrorCode } from '../../shared/errors';
import { throwIfCancelled } from '../../shared/cancellation';
import { awaitChatRead } from './attachments';

const CHAT_API_ORIGIN = 'https://chat.agendor.com.br/api/v1';
const CHAT_TIMEOUT_MS = 10_000;
const CHAT_MAX_RESPONSE_BYTES = 1_048_576;

export interface ChatTransportOptions {
  token: string;
  budgetGate: BudgetGate;
  signal?: AbortSignal;
  request?: (request: Request) => Promise<Response>;
  waitForBudget?: boolean;
}

export function createChatTransport(options: ChatTransportOptions) {
  const { budgetGate, token } = options;

  async function reserve(wait: boolean, signal?: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      try {
        await budgetGate();
        return;
      } catch (error) {
        if (!wait || !(error instanceof SafeError) || error.code !== 'UPSTREAM_RATE_LIMITED' || attempt >= 3)
          throw error;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await awaitChatRead(
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 10_000);
            }),
            signal ?? AbortSignal.timeout(35_000),
          );
        } finally {
          clearTimeout(timer);
        }
      }
    }
  }

  async function get(path: string): Promise<unknown> {
    throwIfCancelled(options.signal);
    await reserve(options.waitForBudget === true, options.signal);
    throwIfCancelled(options.signal);
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    try {
      const response = await awaitChatRead(
        (options.request ?? fetch)(
          new Request(new URL(CHAT_API_ORIGIN + path), {
            method: 'GET',
            redirect: 'manual',
            signal,
            headers: { Accept: 'application/json', api_access_token: token },
          }),
        ),
        signal,
      );
      if (!response.ok) {
        if (response.body) await awaitChatRead(response.body.cancel(), signal);
        const errors: Record<number, [ErrorCode, string, boolean]> = {
          401: ['UPSTREAM_UNAUTHORIZED', 'Chat authentication failed.', false],
          403: ['UPSTREAM_FORBIDDEN', 'Chat access denied.', false],
          404: ['UPSTREAM_NOT_FOUND', 'Conversation not found.', false],
          429: ['UPSTREAM_RATE_LIMITED', 'Chat request limit reached. Retry later.', true],
        };
        const error =
          errors[response.status] ??
          (response.status >= 500
            ? (['UPSTREAM_UNAVAILABLE', 'Chat service temporarily unavailable.', true] as const)
            : (['UPSTREAM_INVALID_RESPONSE', 'Unexpected Chat response.', false] as const));
        throw new SafeError(error[0], error[1], error[2], response.status);
      }
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > CHAT_MAX_RESPONSE_BYTES) {
        if (response.body) await awaitChatRead(response.body.cancel(), signal);
        throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Chat response exceeded the size limit.', false);
      }
      if (!response.body) throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Chat returned an empty response.', false);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await awaitChatRead(reader.read(), signal);
          if (done) break;
          size += value.byteLength;
          if (size > CHAT_MAX_RESPONSE_BYTES) {
            await awaitChatRead(reader.cancel(), signal);
            throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Chat response exceeded the size limit.', false);
          }
          chunks.push(value);
        }
      } finally {
        if (signal.aborted) void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
      } catch {
        throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Chat returned invalid JSON.', false);
      }
    } catch (error) {
      if (error instanceof SafeError) throw error;
      throwIfCancelled(options.signal);
      if (controller.signal.aborted) throw new SafeError('UPSTREAM_TIMEOUT', 'Chat request timed out.', true);
      throw new SafeError('UPSTREAM_UNAVAILABLE', 'Chat service temporarily unavailable.', true, 503);
    } finally {
      clearTimeout(timer);
    }
  }

  return { reserve, get };
}
