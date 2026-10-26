import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const API_ORIGIN = 'https://chat.agendor.com.br/api/v1';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;

function readVars(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values.set(match[1], value);
  }
  return values;
}

function schemaShape(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return { type: 'array', item: value.length && depth < 4 ? schemaShape(value[0], depth + 1) : 'unknown', count: value.length };
  if (typeof value !== 'object') return typeof value;
  const fields = Object.create(null);
  for (const [key, field] of Object.entries(value).slice(0, 40)) fields[key] = depth >= 4 ? typeof field : schemaShape(field, depth + 1);
  return { type: 'object', fields };
}

function findAccountId(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return undefined;
  const data = profile.data && typeof profile.data === 'object' && !Array.isArray(profile.data) ? profile.data : undefined;
  const candidates = [profile.account_id, profile.accountId, profile.account?.id, data?.account_id, data?.accountId, data?.account?.id];
  const value = candidates.find(candidate => (typeof candidate === 'string' || typeof candidate === 'number') && /^\d{1,20}$/.test(String(candidate)));
  return value === undefined ? undefined : String(value);
}

function findFirstConversationId(response) {
  const payload = response?.data?.payload;
  if (!Array.isArray(payload)) return undefined;
  for (const conversation of payload) {
    const value = conversation?.id;
    if ((typeof value === 'number' || typeof value === 'string') && /^\d{1,20}$/.test(String(value))) return String(value);
  }
  return undefined;
}

async function readBounded(response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('Chat response exceeded the size limit.');
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Chat response exceeded the size limit.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
}

async function getJson(route, token, fetchImpl, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(new Request(`${API_ORIGIN}${route}`, {
      method: 'GET', redirect: 'manual', signal: controller.signal,
      headers: { Accept: 'application/json', api_access_token: token },
    }));
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      throw new Error(`Chat request failed (${response.status}).`);
    }
    return { status: response.status, body: await readBounded(response) };
  } catch (error) {
    if (error instanceof Error && /^Chat (request failed|response exceeded)/.test(error.message)) throw error;
    throw new Error(controller.signal.aborted ? 'Chat request timed out.' : 'Chat request failed.');
  } finally { clearTimeout(timer); }
}

async function pauseBetweenRequests() { await new Promise(resolve => setTimeout(resolve, 350)); }

function emit(write, event) { write(JSON.stringify(event)); }

export async function verifyChatContract({ token, accountId, conversationId, fetchImpl = fetch, write = line => console.log(line), persistAccountId, timeoutMs = TIMEOUT_MS }) {
  if (typeof token !== 'string' || token.length < 1 || /\s/.test(token)) throw new Error('Set AGENDOR_CHAT_TOKEN in the ignored local .dev.vars file.');
  const profile = await getJson('/profile', token, fetchImpl, timeoutMs);
  const profileAccountId = findAccountId(profile.body);
  if (profileAccountId && accountId && String(profileAccountId) !== String(accountId)) throw new Error("Configured Chat account ID does not match the authenticated profile.");
  if (profileAccountId && !accountId && persistAccountId) await persistAccountId(profileAccountId);
  emit(write, { endpoint: 'profile', status: profile.status, shape: schemaShape(profile.body), accountIdSource: profileAccountId ? 'profile' : accountId ? 'local configuration' : 'unavailable' });

  const selectedAccountId = profileAccountId ?? accountId;
  if (!selectedAccountId || !/^\d{1,20}$/.test(String(selectedAccountId))) {
    emit(write, { endpoint: 'conversations', status: 'skipped', reason: 'Configure the verified numeric AGENDOR_CHAT_ACCOUNT_ID locally.' });
    return;
  }
  const account = encodeURIComponent(String(selectedAccountId));
  await pauseBetweenRequests();
  const conversations = await getJson(`/accounts/${account}/conversations`, token, fetchImpl, timeoutMs);
  emit(write, { endpoint: 'conversations', status: conversations.status, shape: schemaShape(conversations.body) });

  const selectedConversationId = conversationId && /^\d{1,20}$/.test(String(conversationId))
    ? String(conversationId) : findFirstConversationId(conversations.body);
  if (!selectedConversationId) {
    emit(write, { endpoint: 'conversation detail and messages', status: 'skipped', reason: 'No numeric conversation ID was available in the verified response.' });
    return;
  }
  const conversation = encodeURIComponent(selectedConversationId);
  emit(write, { endpoint: 'conversation sample', idSource: conversationId ? 'local configuration' : 'first conversation on returned page' });
  await pauseBetweenRequests();
  const detail = await getJson(`/accounts/${account}/conversations/${conversation}`, token, fetchImpl, timeoutMs);
  emit(write, { endpoint: 'conversation detail', status: detail.status, shape: schemaShape(detail.body) });
  await pauseBetweenRequests();
  const messages = await getJson(`/accounts/${account}/conversations/${conversation}/messages`, token, fetchImpl, timeoutMs);
  emit(write, { endpoint: 'conversation messages', status: messages.status, shape: schemaShape(messages.body) });
}

async function persistAccountIdLocally(accountId) {
  const path = '.dev.vars';
  const text = await readFile(path, 'utf8');
  const line = 'AGENDOR_CHAT_ACCOUNT_ID=' + JSON.stringify(accountId);
  const pattern = new RegExp('^\\s*AGENDOR_CHAT_ACCOUNT_ID\\s*=.*$', 'm');
  const updated = pattern.test(text) ? text.replace(pattern, line) : text.trimEnd() + String.fromCharCode(10) + line + String.fromCharCode(10);
  await writeFile(path, updated);
}
async function main() {
  const vars = readVars(await readFile('.dev.vars', 'utf8'));
  await verifyChatContract({
    token: vars.get('AGENDOR_CHAT_TOKEN'),
    accountId: vars.get('AGENDOR_CHAT_ACCOUNT_ID'),
    conversationId: vars.get('AGENDOR_CHAT_CONVERSATION_ID'),
    persistAccountId: persistAccountIdLocally,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const message = error instanceof Error && /^Set AGENDOR_CHAT_TOKEN|^Chat (request failed|response exceeded)/.test(error.message)
      ? error.message : 'Chat contract verification failed.';
    console.error(message);
    process.exitCode = 1;
  });
}
