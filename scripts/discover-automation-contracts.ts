import type { ContractCapabilities, ContractCapability } from '../test/fixtures/automation-contracts.ts';
import { isEntrypoint } from './lib/args.ts';

const CHAT = 'https://chat.agendor.com.br/api/v1';
const CRM = 'https://api.agendor.com.br/v3';
const POSTMAN = 'https://documenter.getpostman.com/view/28016625/2sAXxV4UX5';
const OPENAPI = 'https://api.agendor.com.br/v3/swagger.json';
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;
const LIVE_DISCOVERY_BLOCKED = 'Shared per-product budget unavailable; live discovery requires the Task 6 adapter.';
const CATALOG = ['funnels', 'deal_stages', 'users', 'products', 'lead_origins', 'categories', 'sectors'] as const;
const ENTITIES = ['organizations', 'people', 'deals', 'products'] as const;

export interface DiscoverAutomationContractsOptions {
  request: (request: Request) => Promise<Response>;
  emit: (line: string) => unknown;
  timeoutMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numericId(value: unknown): string | undefined {
  return (typeof value === 'string' || typeof value === 'number') && /^[1-9]\d{0,19}$/.test(String(value))
    ? String(value)
    : undefined;
}

function payload(body: unknown): unknown[] | undefined {
  const root = asRecord(body);
  const data = asRecord(root?.data);
  const candidate = data?.payload ?? root?.payload ?? root?.data;
  return Array.isArray(candidate) ? candidate : undefined;
}

// No upstream keys or values are copied to output, including dynamic custom field keys.
function observation(label: string, body: unknown): string {
  const shape = Array.isArray(body) ? 'array' : body && typeof body === 'object' ? 'object' : 'invalid';
  return `${label}: ${shape}${payload(body) ? '; collection:array' : ''}`;
}

async function readBounded(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('bounded');
  }
  if (!response.body) throw new Error('empty');
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const cancel = (): void => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new Error('bounded');
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  if (signal.aborted) throw new Error('timeout');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
}

/** Operator-only contract observation; importing this module never reads files or calls fetch. */
export async function discoverAutomationContracts({
  request,
  emit,
  timeoutMs = TIMEOUT_MS,
}: DiscoverAutomationContractsOptions): Promise<ContractCapabilities> {
  if (typeof request !== 'function' || typeof emit !== 'function') {
    throw new Error('Injected request and emit are required.');
  }
  const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, TIMEOUT_MS) : TIMEOUT_MS;
  const capability = (reference: string): ContractCapability => ({
    status: 'unverified',
    references: [reference],
    evidence: [],
  });
  const report: ContractCapabilities = {
    chatMessageAfter: capability(POSTMAN),
    chatHistory: capability(POSTMAN),
    conversationDiscovery: capability(POSTMAN),
    contacts: capability(POSTMAN),
    attachments: capability(POSTMAN),
    customFields: capability(OPENAPI),
    collectionWriteSemantics: capability(OPENAPI),
  };

  let calls = 0;
  async function get(origin: string, route: string, target: ContractCapability, label: string): Promise<unknown> {
    if (++calls > 20 || ![CHAT, CRM].includes(origin)) throw new Error('Discovery limit.');
    const controller = new AbortController();
    const outgoing = new Request(origin + route, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    let response: Response | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      // Retain Request until the deadline; a transport may keep only its dependent signal.
      timer = setTimeout(() => {
        if (!outgoing.signal.aborted) controller.abort();
        reject(new Error('timeout'));
      }, duration);
    });
    try {
      const body = await Promise.race([
        deadline,
        (async () => {
          response = await request(outgoing);
          if (!response.ok || response.redirected) {
            await response.body?.cancel();
            throw new Error('http');
          }
          if (controller.signal.aborted) {
            await response.body?.cancel();
            throw new Error('timeout');
          }
          return readBounded(response, controller.signal);
        })(),
      ]);
      target.evidence.push(observation(label, body));
      return body;
    } catch {
      // Errors, HTTP bodies, URLs, and response keys can contain secrets/customer data.
      target.evidence.push(`${label}: unavailable`);
      return undefined;
    } finally {
      clearTimeout(timer);
      if (controller.signal.aborted && response?.body && !response.body.locked) {
        await response.body.cancel().catch(() => {});
      }
    }
  }

  const profile = await get(CHAT, '/profile', report.conversationDiscovery, 'profile');
  const profileRecord = asRecord(profile);
  const profileData = asRecord(profileRecord?.data);
  const account = numericId(profileRecord?.account_id ?? profileData?.account_id);
  if (account) {
    const base = `/accounts/${account}`;
    const conversations = await get(CHAT, `${base}/conversations`, report.conversationDiscovery, 'conversations');
    const conversation = payload(conversations)
      ?.map((item) => numericId(asRecord(item)?.id))
      .find(Boolean);
    const contacts = await get(CHAT, `${base}/contacts`, report.contacts, 'contacts');
    if (payload(contacts)) report.contacts.status = 'verified';
    const contact = payload(contacts)
      ?.map((item) => numericId(asRecord(item)?.id))
      .find(Boolean);
    if (contact) {
      await get(
        CHAT,
        `${base}/contacts/${contact}/conversations`,
        report.conversationDiscovery,
        'contact conversations',
      );
    }
    if (conversation) {
      const route = `${base}/conversations/${conversation}`;
      const messages = await get(CHAT, `${route}/messages`, report.chatHistory, 'messages');
      const message = payload(messages)
        ?.map((item) => numericId(asRecord(item)?.id))
        .find(Boolean);
      if (message) {
        await get(CHAT, `${route}/messages?after=${message}`, report.chatMessageAfter, 'messages with after');
      }
      const attachments = await get(CHAT, `${route}/attachments`, report.attachments, 'attachments');
      if (payload(attachments)) report.attachments.status = 'verified';
    }
  }
  for (const section of CATALOG) await get(CRM, `/${section}`, report.customFields, section);
  let fieldsVerified = true;
  for (const entity of ENTITIES) {
    const fields = await get(CRM, `/custom_fields/${entity}`, report.customFields, `custom fields ${entity}`);
    fieldsVerified &&= Array.isArray(asRecord(fields)?.data);
  }
  if (fieldsVerified) report.customFields.status = 'verified';
  report.chatMessageAfter.evidence.push('Parameter documented; ordering and continuation semantics unverified.');
  report.chatHistory.evidence.push('Default page only; complete history unverified.');
  report.conversationDiscovery.evidence.push('Default pages only; exhaustive discovery unverified.');
  report.collectionWriteSemantics.evidence.push(
    'No writes performed; replacement, merge and deletion semantics unverified.',
  );
  emit(JSON.stringify(report));
  return report;
}

async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[2] !== '--live') {
    throw new Error('Use only --live to explicitly opt in to GET discovery.');
  }
  // Task 6 must supply the same durable account/credential budget used by MCP and automation.
  // A process-local delay or native datacenter limiter cannot satisfy shared accounting.
  // Fail before credential access or fetch; the injected synthetic observer remains usable.
  await Promise.resolve();
  throw new Error(LIVE_DISCOVERY_BLOCKED);
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error &&
        (error.message.startsWith('Use only --live') || error.message === LIVE_DISCOVERY_BLOCKED)
        ? error.message
        : 'Automation contract discovery failed.',
    );
    process.exitCode = 1;
  });
}
