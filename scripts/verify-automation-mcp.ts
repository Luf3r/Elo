import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { isEntrypoint, parseCliArgs, readJsonFile } from './lib/args.ts';
import { withMcpClient, type McpToolCallResult, type McpToolCaller } from './lib/mcp-client.ts';
import { readSession, validateMcpTarget } from './lib/oauth-session.ts';
import { assertNoSecrets, collectKnownSecrets } from './lib/redaction.ts';

const MAX_BYTES = 512 * 1024;
const KNOWN_CODES = new Set([
  'MCP_UNAUTHORIZED',
  'INVALID_INPUT',
  'UPSTREAM_TIMEOUT',
  'UPSTREAM_RATE_LIMITED',
  'RESULT_TOO_LARGE',
]);

const SAFE_STATES = new Set([
  'ready',
  'review',
  'noop',
  'continue',
  'deferred',
  'queued',
  'applied',
  'uncertain',
  'authorization_expired',
]);

export interface PilotConversation {
  id: number;
  inboxId: number;
}

export interface PilotRecord {
  kind: string;
  id: number;
}

export interface PilotOperation {
  commandKey: string;
  kind: string;
  sha256: string;
}

export interface PilotManifest {
  approvedBy: string;
  expiresAt: string;
  requestId: string;
  conversations: PilotConversation[];
  records: PilotRecord[];
  operations: PilotOperation[];
}

export interface VerificationStep {
  tool: string;
  code: string;
  commands?: number;
}

export interface VerificationSummary {
  state: string;
  steps: VerificationStep[];
  remoteCalls?: number;
}

export interface VerificationOptions {
  call?: McpToolCaller;
  read?: boolean;
  write?: boolean;
  conversationId?: number;
  analysis?: Record<string, unknown>;
  pilot?: PilotManifest;
  secrets?: string[];
}

interface PrepareWork {
  workId: string;
  leaseToken: string;
  snapshotVersion: number;
  contextVersion: number;
}

interface PrepareResponse {
  state?: unknown;
  workId?: string;
  leaseToken?: string;
  continuation?: unknown;
  work?: PrepareWork;
  [key: string]: unknown;
}

interface PlanCommand {
  commandKey: string;
  kind: string;
  target?: { kind?: string; id?: number };
  [key: string]: unknown;
}

interface PlanResponse {
  state?: unknown;
  planId?: string;
  version?: number;
  orderedCommands?: PlanCommand[];
  [key: string]: unknown;
}

function safeState(value: unknown): string {
  return typeof value === 'string' && SAFE_STATES.has(value) ? value : 'failed';
}

function tryParseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Compute the canonical SHA-256 digest expected in pilot manifests for an automation command. */
export function commandDigest(command: unknown): string {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex');
}

function pilotValid(pilot: PilotManifest | undefined, conversationId: number | undefined): pilot is PilotManifest {
  return Boolean(
    pilot &&
    typeof pilot.approvedBy === 'string' &&
    pilot.approvedBy.trim() &&
    Date.parse(pilot.expiresAt) > Date.now() &&
    Array.isArray(pilot.conversations) &&
    pilot.conversations.some((c) => c.id === conversationId && Number.isSafeInteger(c.inboxId) && c.inboxId > 0) &&
    typeof pilot.requestId === 'string' &&
    pilot.requestId.length > 0 &&
    pilot.requestId.length <= 200 &&
    Array.isArray(pilot.records) &&
    Array.isArray(pilot.operations) &&
    pilot.operations.length > 0 &&
    pilot.operations.length <= 20,
  );
}

function extractErrorCode(result: McpToolCallResult): string | undefined {
  if (typeof result.error?.code === 'string') {
    return result.error.code;
  }
  const text = result.content?.find((c) => c.type === 'text')?.text;
  if (typeof text !== 'string') return undefined;
  const parsed = tryParseJsonObject(text);
  const errorObj = parsed?.error;
  if (errorObj !== null && typeof errorObj === 'object' && !Array.isArray(errorObj)) {
    const code = (errorObj as Record<string, unknown>).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** No IO by default. The injected client makes every attempted MCP call observable. */
export async function runVerification({
  call,
  read = false,
  write = false,
  conversationId,
  analysis,
  pilot,
  secrets = [],
}: VerificationOptions = {}): Promise<VerificationSummary> {
  if (write) assert(read && analysis && pilotValid(pilot, conversationId), 'PILOT_AUTHORIZATION_REQUIRED');
  if (!read) return { state: 'offline', steps: [], remoteCalls: 0 };
  assert(
    typeof conversationId === 'number' && Number.isSafeInteger(conversationId) && conversationId > 0,
    'Use one explicit conversation ID.',
  );
  assert(typeof call === 'function', 'MCP call handler is required.');

  const steps: VerificationStep[] = [];
  async function invoke<T extends Record<string, unknown>>(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<T | undefined> {
    const result = await call!(name, args);
    const text = JSON.stringify(result);
    assertNoSecrets(text, secrets, 'RESULT_REDACTION_FAILED');
    if (new TextEncoder().encode(text).byteLength > MAX_BYTES) {
      steps.push({ tool: name, code: 'RESULT_TOO_LARGE' });
      return undefined;
    }
    if (result?.isError || result?.error) {
      const code = extractErrorCode(result);
      steps.push({ tool: name, code: code !== undefined && KNOWN_CODES.has(code) ? code : 'MCP_ERROR' });
      return undefined;
    }
    let body: Record<string, unknown> | undefined = result;
    if (Array.isArray(result?.content)) {
      const rawText = result.content.find((c) => c.type === 'text')?.text ?? '{}';
      body = tryParseJsonObject(rawText);
      if (!body) {
        steps.push({ tool: name, code: 'MALFORMED_RESULT' });
        return undefined;
      }
    }
    const orderedCommands = body.orderedCommands;
    steps.push({
      tool: name,
      code: 'OK',
      ...(Array.isArray(orderedCommands) ? { commands: orderedCommands.length } : {}),
    });
    return body as T;
  }

  if (!(await invoke('automation_get_status'))) return { state: 'failed', steps };
  let prepared = await invoke<PrepareResponse>('automation_prepare_sync', {
    requestId: write && pilot ? pilot.requestId : `verify:${randomUUID()}`,
    target: { kind: 'conversation', conversationId },
    mode: write ? 'apply' : 'preview',
  });
  for (let i = 0; prepared?.state === 'continue' && i < 10; i++) {
    prepared = await invoke<PrepareResponse>('automation_prepare_sync', {
      requestId: `verify:${randomUUID()}`,
      workId: prepared.workId,
      leaseToken: prepared.leaseToken,
      continuation: prepared.continuation,
    });
  }
  if (prepared?.state !== 'ready' || !analysis || !prepared.work) {
    return { state: safeState(prepared?.state), steps };
  }
  const work = prepared.work;
  const plan = await invoke<PlanResponse>('automation_submit_analysis', {
    workId: work.workId,
    leaseToken: work.leaseToken,
    expectedSnapshotVersion: work.snapshotVersion,
    expectedContextVersion: work.contextVersion,
    analysis,
  });
  if (write) {
    const commands = plan?.orderedCommands ?? [];
    assert(
      plan?.state === 'ready' && commands.length > 0 && pilotValid(pilot, conversationId),
      'PILOT_PLAN_NOT_AUTHORIZED',
    );
    for (const command of commands) {
      assert(
        pilot.operations.some(
          (o) => o.commandKey === command.commandKey && o.kind === command.kind && o.sha256 === commandDigest(command),
        ),
        'PILOT_COMMAND_NOT_AUTHORIZED',
      );
      if (command.target?.id !== undefined) {
        assert(
          pilot.records.some((r) => r.kind === command.target?.kind && r.id === command.target.id),
          'PILOT_RECORD_NOT_AUTHORIZED',
        );
      }
    }
    await invoke('automation_apply_plan', {
      planId: plan?.planId,
      planVersion: plan?.version,
      requestId: `pilot:${randomUUID()}`,
    });
  }
  return { state: safeState(plan?.state), steps };
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2), {
    flags: ['--read', '--write'],
    options: ['--conversation', '--analysis', '--pilot'],
    unknownOptionMessage: 'Unknown verifier option.',
    missingValueMessage: 'Option requires a value.',
  });
  const read = parsed.flags.has('--read');
  const write = parsed.flags.has('--write');
  if (!read && !write) {
    console.log(JSON.stringify(await runVerification()));
    return;
  }

  const conversationRaw = parsed.values.get('--conversation');
  const analysisPath = parsed.values.get('--analysis');
  const pilotPath = parsed.values.get('--pilot');
  const conversationId = Number(conversationRaw);
  const analysis = analysisPath ? readJsonFile<Record<string, unknown>>(analysisPath) : undefined;
  const pilot = pilotPath ? readJsonFile<PilotManifest>(pilotPath) : undefined;
  assert(
    read && Number.isSafeInteger(conversationId) && conversationId > 0,
    'Use --read and one explicit conversation.',
  );
  if (write) assert(analysis && pilotValid(pilot, conversationId), 'PILOT_AUTHORIZATION_REQUIRED');

  const target = validateMcpTarget(process.env.MCP_URL);
  const session = readSession();
  const secrets = collectKnownSecrets([session.accessToken]);

  const summary = await withMcpClient(
    { target, accessToken: session.accessToken, clientName: 'elo-automation-verifier' },
    (call) =>
      runVerification({
        call,
        read,
        write,
        conversationId,
        analysis,
        pilot,
        secrets,
      }),
  );
  console.log(JSON.stringify(summary));
  if (summary.state === 'failed') process.exitCode = 1;
}

if (isEntrypoint(import.meta.url)) {
  main().catch(() => {
    console.error(
      'AUTOMATION_VERIFICATION_FAILED: check authorization, options and bounded pilot; response bodies are suppressed.',
    );
    process.exitCode = 1;
  });
}
