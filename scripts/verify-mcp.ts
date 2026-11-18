import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntrypoint, loadLocalDevVars } from './lib/args.ts';
import { assertUnauthorizedMcpRequests, probeHealth } from './lib/mcp-client.ts';
import { readSession, validateMcpTarget } from './lib/oauth-session.ts';
import { assertNoSecrets } from './lib/redaction.ts';

interface InspectorCliModule {
  runCli: (argv: string[]) => Promise<void>;
}

interface ListedToolsPayload {
  tools?: Array<{ name: string }>;
}

interface ToolCallTextPayload {
  content?: Array<{ text?: string }>;
}

interface ParsedInspectorOutput {
  isError?: boolean;
  error?: unknown;
  result?: unknown;
}

const REQUIRED_TOOLS = [
  'server_status',
  'crm_find_person_by_email',
  'crm_search_people',
  'crm_search_organizations',
  'crm_get_organization',
  'crm_search_deals',
  'crm_get_deal',
  'crm_list_tasks',
  'chat_list_conversations',
  'chat_get_conversation',
  'chat_list_messages',
] as const;

const OPTIONAL_TOOLS = [
  'crm_update_deal',
  'crm_update_deal_stage',
  'crm_update_person',
  'crm_update_organization',
  'crm_get_person',
  'crm_get_task',
  'crm_get_configuration',
  'chat_search_contacts',
  'chat_get_contact',
  'chat_list_contact_conversations',
  'chat_list_attachments',
  'chat_get_attachment',
  'automation_preflight_sync',
  'automation_discover_pending',
  'automation_prepare_sync',
  'automation_submit_analysis',
  'automation_apply_plan',
  'automation_get_operation',
  'automation_get_customer_context',
  'automation_list_reviews',
  'automation_resolve_review',
  'automation_get_status',
  'automation_list_audit',
  'automation_update_policy',
  'automation_reprocess',
  'crm_create_organization',
  'crm_create_person',
  'crm_create_deal',
  'crm_create_task',
  'crm_enrich_organization',
  'crm_enrich_person',
  'crm_enrich_deal',
  'crm_update_task',
] as const;

/** Run end-to-end read-only MCP verification via the pinned Inspector CLI without leaking credentials. */
export async function verifyMcp(): Promise<void> {
  loadLocalDevVars();
  const target = validateMcpTarget(process.env.MCP_URL);
  assert(
    target.pathname === '/mcp' && !target.username && !target.password && !target.search && !target.hash,
    'Use an exact /mcp URL without credentials or query.',
  );
  assert(
    (target.protocol === 'https:' && target.hostname.endsWith('.workers.dev')) ||
      (target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)),
    'Only local HTTP or HTTPS workers.dev targets are allowed.',
  );
  const credential = process.env.MCP_OAUTH_ACCESS_TOKEN ?? readSession().accessToken;
  assert(credential, 'Complete OAuth browser login first.');

  const inspectorModule = (await import(
    pathToFileURL(resolve('node_modules/@modelcontextprotocol/inspector/clients/cli/build/index.js')).href
  )) as InspectorCliModule;

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);

  async function inspect<T>(method: string, tool?: string, args: Record<string, unknown> = {}): Promise<T> {
    process.stderr.write(`Inspector: ${tool ?? method}\n`);
    let captured = '';
    process.stdout.write = (
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      callback?: (err?: Error | null) => void,
    ): boolean => {
      captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      const done = typeof encodingOrCb === 'function' ? encodingOrCb : callback;
      if (done) done();
      return true;
    };
    try {
      // Invoke pinned Inspector in-process: the credential never appears in OS argv or a config file.
      await inspectorModule.runCli([
        process.execPath,
        'inspector',
        '--server-url',
        target.href,
        '--transport',
        'http',
        '--protocol-era',
        'modern',
        '--stored-auth-only',
        '--connect-timeout',
        '15000',
        '--format',
        'json',
        '--quiet',
        '--header',
        `Authorization: Bearer ${credential}`,
        '--method',
        method,
        ...(tool ? ['--tool-name', tool, '--tool-args-json', JSON.stringify(args)] : []),
      ]);
    } finally {
      process.stdout.write = originalStdoutWrite;
    }

    assertNoSecrets(captured, [process.env.AGENDOR_CRM_TOKEN], 'Upstream credential appeared in an MCP result.');
    assertNoSecrets(captured, [credential], 'MCP credential appeared in an MCP result.');

    const parsed = JSON.parse(captured.trim()) as ParsedInspectorOutput;
    const result = (parsed.result ?? parsed) as ParsedInspectorOutput;
    assert(!result.isError && !parsed.error, 'Inspector returned an MCP error; no record content displayed.');
    return result as T;
  }

  const health = await probeHealth(target);
  assert.equal(health.status, 200);

  const requestBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  await assertUnauthorizedMcpRequests(target, [{}, { Authorization: 'Bearer intentionally-invalid-token' }], {
    method: 'POST',
    body: requestBody,
  });

  const listed = await inspect<ListedToolsPayload>('tools/list');
  const names = (listed.tools ?? []).map((tool) => tool.name);
  assert(
    REQUIRED_TOOLS.every((name) => names.includes(name)),
    'Required production tools are missing.',
  );
  assert(
    names.every(
      (name) =>
        (REQUIRED_TOOLS as readonly string[]).includes(name) || (OPTIONAL_TOOLS as readonly string[]).includes(name),
    ),
    'Unexpected MCP tool is exposed.',
  );

  await inspect('tools/call', 'server_status');
  await inspect('tools/call', 'chat_list_conversations');
  const readCalls: Array<[string, Record<string, unknown>]> = [
    ['crm_search_people', { perPage: 1 }],
    ['crm_search_organizations', { perPage: 1 }],
    ['crm_search_deals', { perPage: 1 }],
    ['crm_list_tasks', { perPage: 1, updatedDateGt: new Date(Date.now() - 86_400_000).toISOString() }],
  ];
  for (const [tool, args] of readCalls) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
    const result = await inspect<ToolCallTextPayload>('tools/call', tool, args);
    const firstText = result.content?.[0]?.text ?? '{}';
    const body = JSON.parse(firstText) as { items?: unknown };
    assert(Array.isArray(body.items));
  }

  console.log(
    JSON.stringify({
      target: target.href,
      health: 'PASS',
      authentication: 'PASS',
      inspector: '2.11.0',
      tools: names.length,
      realCrmReads: 4,
      secretsInResults: false,
    }),
  );
}

if (isEntrypoint(import.meta.url)) {
  verifyMcp().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
