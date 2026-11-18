import { readFile, writeFile } from 'node:fs/promises';
import { isEntrypoint, parseEnvVars } from './lib/args.ts';

const API_ORIGIN = 'https://chat.agendor.com.br/api/v1';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;

type ShapeDescriptor =
  | string
  | { type: 'array'; item: ShapeDescriptor; count: number }
  | { type: 'object'; fields: Record<string, ShapeDescriptor> };

export interface VerifyChatContractOptions {
  token?: string;
  accountId?: string;
  conversationId?: string;
  fetchImpl?: typeof fetch;
  write?: (line: string) => void;
  persistAccountId?: (accountId: string) => Promise<void> | void;
  timeoutMs?: number;
}

function schemaShape(value: unknown, depth = 0): ShapeDescriptor {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return {
      type: 'array',
      item: value.length > 0 && depth < 4 ? schemaShape(value[0], depth + 1) : 'unknown',
      count: value.length,
    };
  }
  if (typeof value !== 'object') return typeof value;
  const fields: Record<string, ShapeDescriptor> = Object.create(null) as Record<string, ShapeDescriptor>;
  for (const [key, field] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
    fields[key] = depth >= 4 ? typeof field : schemaShape(field, depth + 1);
  }
  return { type: 'object', fields };
}

function findAccountId(profile: unknown): string | undefined {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return undefined;
  const record = profile as Record<string, unknown>;
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : undefined;
  const recordAccount =
    record.account && typeof record.account === 'object' && !Array.isArray(record.account)
      ? (record.account as Record<string, unknown>)
      : undefined;
  const dataAccount =
    data?.account && typeof data.account === 'object' && !Array.isArray(data.account)
      ? (data.account as Record<string, unknown>)
      : undefined;
  const candidates = [
    record.account_id,
    record.accountId,
    recordAccount?.id,
    data?.account_id,
    data?.accountId,
    dataAccount?.id,
  ];
  for (const candidate of candidates) {
    if ((typeof candidate === 'string' || typeof candidate === 'number') && /^\d{1,20}$/.test(String(candidate))) {
      return String(candidate);
    }
  }
  return undefined;
}

function findFirstConversationId(response: unknown): string | undefined {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return undefined;
  const data = (response as Record<string, unknown>).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const payload = (data as Record<string, unknown>).payload;
  if (!Array.isArray(payload)) return undefined;
  for (const conversation of payload) {
    if (!conversation || typeof conversation !== 'object') continue;
    const value = (conversation as Record<string, unknown>).id;
    if ((typeof value === 'number' || typeof value === 'string') && /^\d{1,20}$/.test(String(value))) {
      return String(value);
    }
  }
  return undefined;
}

async function readBounded(response: Response): Promise<unknown> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('Chat response exceeded the size limit.');
  }
  if (!response.body) return null;
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Chat response exceeded the size limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body)) as unknown;
}

async function getJson(
  route: string,
  token: string,
  fetchImpl: typeof fetch,
  timeoutMs = TIMEOUT_MS,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response | undefined;
  let transportFailure = false;
  try {
    response = await fetchImpl(
      new Request(`${API_ORIGIN}${route}`, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'application/json', api_access_token: token },
      }),
    );
  } catch {
    // Intentionally suppress transport errors and headers from propagated failures.
    transportFailure = true;
  }

  try {
    if (transportFailure || !response) {
      throw new Error(controller.signal.aborted ? 'Chat request timed out.' : 'Chat request failed.');
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      throw new Error(`Chat request failed (${response.status}).`);
    }
    try {
      return { status: response.status, body: await readBounded(response) };
    } catch (error: unknown) {
      if (error instanceof Error && /^Chat (request failed|response exceeded)/.test(error.message)) {
        throw error;
      }
      throw new Error(controller.signal.aborted ? 'Chat request timed out.' : 'Chat request failed.', {
        cause: error,
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

async function pauseBetweenRequests(): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
}

function emit(write: (line: string) => void, event: Record<string, unknown>): void {
  write(JSON.stringify(event));
}

/** Verify pinned read-only Agendor Chat API endpoints without emitting customer payloads or secrets. */
export async function verifyChatContract({
  token,
  accountId,
  conversationId,
  fetchImpl = fetch,
  write = (line) => console.log(line),
  persistAccountId,
  timeoutMs = TIMEOUT_MS,
}: VerifyChatContractOptions): Promise<void> {
  if (typeof token !== 'string' || token.length < 1 || /\s/.test(token)) {
    throw new Error('Set AGENDOR_CHAT_TOKEN in the ignored local .dev.vars file.');
  }
  const profile = await getJson('/profile', token, fetchImpl, timeoutMs);
  const profileAccountId = findAccountId(profile.body);
  if (profileAccountId && accountId && String(profileAccountId) !== String(accountId)) {
    throw new Error('Configured Chat account ID does not match the authenticated profile.');
  }
  if (profileAccountId && !accountId && persistAccountId) await persistAccountId(profileAccountId);
  emit(write, {
    endpoint: 'profile',
    status: profile.status,
    shape: schemaShape(profile.body),
    accountIdSource: profileAccountId ? 'profile' : accountId ? 'local configuration' : 'unavailable',
  });

  const selectedAccountId = profileAccountId ?? accountId;
  if (!selectedAccountId || !/^\d{1,20}$/.test(String(selectedAccountId))) {
    emit(write, {
      endpoint: 'conversations',
      status: 'skipped',
      reason: 'Configure the verified numeric AGENDOR_CHAT_ACCOUNT_ID locally.',
    });
    return;
  }
  const account = encodeURIComponent(String(selectedAccountId));
  await pauseBetweenRequests();
  const conversations = await getJson(`/accounts/${account}/conversations`, token, fetchImpl, timeoutMs);
  emit(write, { endpoint: 'conversations', status: conversations.status, shape: schemaShape(conversations.body) });

  const selectedConversationId =
    conversationId && /^\d{1,20}$/.test(String(conversationId))
      ? String(conversationId)
      : findFirstConversationId(conversations.body);
  if (!selectedConversationId) {
    emit(write, {
      endpoint: 'conversation detail and messages',
      status: 'skipped',
      reason: 'No numeric conversation ID was available in the verified response.',
    });
    return;
  }
  const conversation = encodeURIComponent(selectedConversationId);
  emit(write, {
    endpoint: 'conversation sample',
    idSource: conversationId ? 'local configuration' : 'first conversation on returned page',
  });
  await pauseBetweenRequests();
  const detail = await getJson(`/accounts/${account}/conversations/${conversation}`, token, fetchImpl, timeoutMs);
  emit(write, { endpoint: 'conversation detail', status: detail.status, shape: schemaShape(detail.body) });
  await pauseBetweenRequests();
  const messages = await getJson(
    `/accounts/${account}/conversations/${conversation}/messages`,
    token,
    fetchImpl,
    timeoutMs,
  );
  emit(write, { endpoint: 'conversation messages', status: messages.status, shape: schemaShape(messages.body) });
}

async function persistAccountIdLocally(accountId: string): Promise<void> {
  const path = '.dev.vars';
  const text = await readFile(path, 'utf8');
  const line = 'AGENDOR_CHAT_ACCOUNT_ID=' + JSON.stringify(accountId);
  const pattern = /^\s*AGENDOR_CHAT_ACCOUNT_ID\s*=.*$/m;
  const updated = pattern.test(text)
    ? text.replace(pattern, line)
    : text.trimEnd() + String.fromCharCode(10) + line + String.fromCharCode(10);
  await writeFile(path, updated);
}

async function main(): Promise<void> {
  const vars = parseEnvVars(await readFile('.dev.vars', 'utf8'));
  await verifyChatContract({
    token: vars.get('AGENDOR_CHAT_TOKEN'),
    accountId: vars.get('AGENDOR_CHAT_ACCOUNT_ID'),
    conversationId: vars.get('AGENDOR_CHAT_CONVERSATION_ID'),
    persistAccountId: persistAccountIdLocally,
  });
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error && /^Set AGENDOR_CHAT_TOKEN|^Chat (request failed|response exceeded)/.test(error.message)
        ? error.message
        : 'Chat contract verification failed.';
    console.error(message);
    process.exitCode = 1;
  });
}
