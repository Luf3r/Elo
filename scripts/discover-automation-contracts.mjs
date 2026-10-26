import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const CHAT = 'https://chat.agendor.com.br/api/v1';
const CRM = 'https://api.agendor.com.br/v3';
const POSTMAN = 'https://documenter.getpostman.com/view/28016625/2sAXxV4UX5';
const OPENAPI = 'https://api.agendor.com.br/v3/swagger.json';
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;
const CATALOG = ['funnels', 'deal_stages', 'users', 'products', 'lead_origins', 'categories', 'sectors'];
const ENTITIES = ['organizations', 'people', 'deals', 'products'];

function numericId(value) {
  return (typeof value === 'string' || typeof value === 'number') && /^[1-9]\d{0,19}$/.test(String(value)) ? String(value) : undefined;
}
function payload(body) {
  const candidate = body?.data?.payload ?? body?.payload ?? body?.data;
  return Array.isArray(candidate) ? candidate : undefined;
}
// No upstream keys or values are copied to output, including dynamic custom field keys.
function observation(label, body) {
  return `${label}: ${Array.isArray(body) ? 'array' : body && typeof body === 'object' ? 'object' : 'invalid'}${payload(body) ? '; collection:array' : ''}`;
}
async function readBounded(response, signal) {
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_BYTES) { await response.body?.cancel(); throw new Error('bounded'); }
  if (!response.body) throw new Error('empty');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('bounded'); }
      chunks.push(value);
    }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
  if (signal.aborted) throw new Error('timeout');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/**
 * Operator-only contract observation; importing this module never reads files or calls fetch.
 * @param {{request: (request: Request) => Promise<Response>, emit: (line: string) => unknown, timeoutMs?: number}} options
 * @returns {Promise<import('../test/fixtures/automation-contracts.ts').ContractCapabilities>}
 */
export async function discoverAutomationContracts({ request, emit, timeoutMs = TIMEOUT_MS }) {
  if (typeof request !== 'function' || typeof emit !== 'function') throw new Error('Injected request and emit are required.');
  const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, TIMEOUT_MS) : TIMEOUT_MS;
  const capability = reference => ({ status: 'unverified', references: [reference], evidence: [] });
  const report = {
    chatMessageAfter: capability(POSTMAN), chatHistory: capability(POSTMAN),
    conversationDiscovery: capability(POSTMAN), contacts: capability(POSTMAN),
    attachments: capability(POSTMAN), customFields: capability(OPENAPI),
    collectionWriteSemantics: capability(OPENAPI),
  };
  let calls = 0;
  async function get(origin, route, target, label) {
    if (++calls > 20 || ![CHAT, CRM].includes(origin)) throw new Error('Discovery limit.');
    const controller = new AbortController();
    const outgoing = new Request(origin + route, {
      method: 'GET', redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/json' },
    });
    let response;
    let timer;
    const deadline = new Promise((_, reject) => {
      // Retain Request until the deadline; a transport may keep only its dependent signal.
      timer = setTimeout(() => { if (!outgoing.signal.aborted) controller.abort(); reject(new Error('timeout')); }, duration);
    });
    try {
      const body = await Promise.race([deadline, (async () => {
        response = await request(outgoing);
        if (!response.ok || response.redirected) { await response.body?.cancel(); throw new Error('http'); }
        if (controller.signal.aborted) { await response.body?.cancel(); throw new Error('timeout'); }
        return readBounded(response, controller.signal);
      })()]);
      target.evidence.push(observation(label, body));
      return body;
    } catch {
      // Errors, HTTP bodies, URLs, and response keys can contain secrets/customer data.
      target.evidence.push(`${label}: unavailable`);
      return undefined;
    } finally {
      clearTimeout(timer);
      if (controller.signal.aborted && response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }
  const profile = await get(CHAT, '/profile', report.conversationDiscovery, 'profile');
  const account = numericId(profile?.account_id ?? profile?.data?.account_id);
  if (account) {
    const base = `/accounts/${account}`;
    const conversations = await get(CHAT, `${base}/conversations`, report.conversationDiscovery, 'conversations');
    const conversation = payload(conversations)?.map(item => numericId(item?.id)).find(Boolean);
    const contacts = await get(CHAT, `${base}/contacts`, report.contacts, 'contacts');
    if (payload(contacts)) report.contacts.status = 'verified';
    const contact = payload(contacts)?.map(item => numericId(item?.id)).find(Boolean);
    if (contact) await get(CHAT, `${base}/contacts/${contact}/conversations`, report.conversationDiscovery, 'contact conversations');
    if (conversation) {
      const route = `${base}/conversations/${conversation}`;
      const messages = await get(CHAT, `${route}/messages`, report.chatHistory, 'messages');
      const message = payload(messages)?.map(item => numericId(item?.id)).find(Boolean);
      if (message) await get(CHAT, `${route}/messages?after=${message}`, report.chatMessageAfter, 'messages with after');
      const attachments = await get(CHAT, `${route}/attachments`, report.attachments, 'attachments');
      if (payload(attachments)) report.attachments.status = 'verified';
    }
  }
  for (const section of CATALOG) await get(CRM, `/${section}`, report.customFields, section);
  let fieldsVerified = true;
  for (const entity of ENTITIES) {
    const fields = await get(CRM, `/custom_fields/${entity}`, report.customFields, `custom fields ${entity}`);
    fieldsVerified &&= Array.isArray(fields?.data);
  }
  if (fieldsVerified) report.customFields.status = 'verified';
  report.chatMessageAfter.evidence.push('Parameter documented; ordering and continuation semantics unverified.');
  report.chatHistory.evidence.push('Default page only; complete history unverified.');
  report.conversationDiscovery.evidence.push('Default pages only; exhaustive discovery unverified.');
  report.collectionWriteSemantics.evidence.push('No writes performed; replacement, merge and deletion semantics unverified.');
  emit(JSON.stringify(report));
  return report;
}

function localVars(text) {
  const result = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(AGENDOR_CHAT_TOKEN|AGENDOR_CRM_TOKEN)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) result.set(match[1], match[2].replace(/^(["'])(.*)\1$/, '$2'));
  }
  return result;
}
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--live') throw new Error('Use only --live to explicitly opt in to GET discovery.');
  const vars = localVars(await readFile('.dev.vars', 'utf8'));
  const chatToken = vars.get('AGENDOR_CHAT_TOKEN');
  const crmToken = vars.get('AGENDOR_CRM_TOKEN');
  if (![chatToken, crmToken].every(token => typeof token === 'string' && token.length > 0 && !/\s/.test(token))) throw new Error('credentials');
  const report = await discoverAutomationContracts({
    request: async req => {
      // The core constructs all routes. Credentials never cross their pinned origin.
      const origin = new URL(req.url).origin;
      const headers = new Headers(req.headers);
      if (origin === 'https://chat.agendor.com.br') headers.set('api_access_token', chatToken);
      else if (origin === 'https://api.agendor.com.br') headers.set('Authorization', `Token ${crmToken}`);
      else throw new Error('origin');
      await new Promise(resolve => setTimeout(resolve, 350));
      if (req.signal.aborted) throw new Error('aborted');
      return fetch(new Request(req, { headers, redirect: 'manual' }));
    }, emit: line => console.log(line),
  });
  await mkdir('.tooling', { recursive: true });
  await writeFile('.tooling/automation-contracts.json', JSON.stringify(report, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error && error.message.startsWith('Use only --live') ? error.message : 'Automation contract discovery failed.');
    process.exitCode = 1;
  });
}
