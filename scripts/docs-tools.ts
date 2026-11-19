import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { isEntrypoint, readJsoncFile } from './lib/args.ts';

const ROOT_DIR = resolve(import.meta.dirname, '..');
const DOCS_TOOLS_PATH = resolve(ROOT_DIR, 'docs/tools.md');

interface SyntheticAuth {
  clientId: string;
  userId: string;
  scopes: string[];
}

interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

interface McpSecurityScheme {
  scopes?: string[];
}

interface McpToolDescriptor {
  name: string;
  annotations?: McpToolAnnotations;
  _meta?: {
    securitySchemes?: McpSecurityScheme[];
  };
}

interface ToolsRunner {
  listToolsForEnv: (env: Record<string, string>, auth: SyntheticAuth) => Promise<McpToolDescriptor[]>;
}

interface AvailabilitySets {
  base: Set<string>;
  crmOnly: Set<string>;
  chatOnly: Set<string>;
}

const SYNTHETIC_AUTH: SyntheticAuth = {
  clientId: 'docs-tools-generator',
  userId: 'docs-tools-user',
  scopes: [],
};

let cachedRunnerPromise: Promise<ToolsRunner> | undefined;

async function loadToolsRunner(): Promise<ToolsRunner> {
  if (!cachedRunnerPromise) {
    cachedRunnerPromise = (async () => {
      const entry = [
        "import { createServer } from './src/mcp/server';",
        "import { InMemoryTransport } from '@modelcontextprotocol/server';",
        "import { Client } from '@modelcontextprotocol/client';",
        'export async function listToolsForEnv(env, auth) {',
        '  const server = createServer(env, auth);',
        '  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();',
        "  const client = new Client({ name: 'docs-tools', version: '1.0.0' });",
        '  await server.connect(serverTransport);',
        '  await client.connect(clientTransport);',
        '  try {',
        '    const result = await client.listTools();',
        '    return result.tools;',
        '  } finally {',
        '    await client.close();',
        '    await server.close();',
        '  }',
        '}',
      ].join('\n');

      const wranglerConfig = readJsoncFile<{ define?: { __ELO_DEPLOYMENT__?: unknown } }>(
        resolve(ROOT_DIR, 'test/wrangler.jsonc'),
      );
      const deploymentDefine = wranglerConfig.define?.__ELO_DEPLOYMENT__;
      if (typeof deploymentDefine !== 'string' || deploymentDefine.length === 0) {
        throw new Error('Missing __ELO_DEPLOYMENT__ define in test/wrangler.jsonc.');
      }

      const result = await build({
        stdin: {
          contents: entry,
          resolveDir: ROOT_DIR,
          sourcefile: 'docs-tools-entry.ts',
          loader: 'ts',
        },
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'node',
        target: 'node22',
        define: {
          __BUILD_COMMIT__: JSON.stringify('unknown'),
          __ELO_DEPLOYMENT__: deploymentDefine,
        },
      });

      const outputFile = result.outputFiles[0];
      if (!outputFile) {
        throw new Error('Failed to bundle docs-tools runner.');
      }
      const bytes = new TextEncoder().encode(outputFile.text);
      let binary = '';
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      const dataUrl = `data:text/javascript;base64,${btoa(binary)}`;
      return (await import(dataUrl)) as ToolsRunner;
    })();
  }
  return cachedRunnerPromise;
}

function makeSyntheticEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    AGENDOR_CRM_TOKEN: '',
    AGENDOR_CHAT_TOKEN: '',
    AGENDOR_CHAT_ACCOUNT_ID: '',
    ACCESS_CLIENT_ID: 'synthetic-client',
    ACCESS_CLIENT_SECRET: 'synthetic-secret',
    ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
    ACCESS_AUTHORIZATION_URL:
      'https://synthetic.cloudflareaccess.com/cdn-cgi/access/sso/oidc/synthetic-client/authorization',
    ACCESS_TOKEN_URL: 'https://synthetic.cloudflareaccess.com/cdn-cgi/access/sso/oidc/synthetic-client/token',
    ACCESS_JWKS_URL: 'https://synthetic.cloudflareaccess.com/cdn-cgi/access/sso/oidc/synthetic-client/jwks',
    ...overrides,
  };
}

function formatScopes(tool: McpToolDescriptor): string {
  const schemes = Array.isArray(tool._meta?.securitySchemes) ? tool._meta.securitySchemes : [];
  const scopes = schemes.flatMap((scheme) => (Array.isArray(scheme.scopes) ? scheme.scopes : []));
  if (scopes.length === 0) {
    return '*(sem escopo de produto)*';
  }
  return scopes.map((scope) => `\`${scope}\``).join(', ');
}

function formatReadWrite(tool: McpToolDescriptor): string {
  return tool.annotations?.readOnlyHint === true ? 'Leitura' : 'Escrita';
}

function formatAnnotations(tool: McpToolDescriptor): string {
  const annotations = tool.annotations ?? {};
  const parts = [
    `readOnly=${Boolean(annotations.readOnlyHint)}`,
    `destructive=${Boolean(annotations.destructiveHint)}`,
    `idempotent=${Boolean(annotations.idempotentHint)}`,
    `openWorld=${Boolean(annotations.openWorldHint)}`,
  ];
  return `\`${parts.join(', ')}\``;
}

function determineAvailability(name: string, sets: AvailabilitySets): string {
  if (sets.base.has(name)) {
    if (name === 'server_status') {
      return 'Sempre registrada (não contata o Agendor)';
    }
    return 'Sempre registrada (falha fechada se `AGENDOR_CRM_TOKEN` ausente)';
  }
  if (sets.crmOnly.has(name)) {
    return 'Requer `AGENDOR_CRM_TOKEN` configurado';
  }
  if (sets.chatOnly.has(name)) {
    return 'Requer `AGENDOR_CHAT_TOKEN` e `AGENDOR_CHAT_ACCOUNT_ID` numérico configurados';
  }
  return 'Requer CRM (`AGENDOR_CRM_TOKEN`) e Chat (`AGENDOR_CHAT_TOKEN` + `AGENDOR_CHAT_ACCOUNT_ID` numérico) configurados';
}

/** Generate `docs/tools.md` Markdown directly from `createServer` `tools/list` output. */
export async function generateToolsMarkdown(): Promise<string> {
  const { listToolsForEnv } = await loadToolsRunner();

  const [baseTools, crmOnlyTools, chatOnlyTools, fullTools] = await Promise.all([
    listToolsForEnv(makeSyntheticEnv(), SYNTHETIC_AUTH),
    listToolsForEnv(makeSyntheticEnv({ AGENDOR_CRM_TOKEN: 'synthetic-crm-token' }), SYNTHETIC_AUTH),
    listToolsForEnv(
      makeSyntheticEnv({ AGENDOR_CHAT_TOKEN: 'synthetic-chat-token', AGENDOR_CHAT_ACCOUNT_ID: '7001' }),
      SYNTHETIC_AUTH,
    ),
    listToolsForEnv(
      makeSyntheticEnv({
        AGENDOR_CRM_TOKEN: 'synthetic-crm-token',
        AGENDOR_CHAT_TOKEN: 'synthetic-chat-token',
        AGENDOR_CHAT_ACCOUNT_ID: '7001',
      }),
      SYNTHETIC_AUTH,
    ),
  ]);

  const sets: AvailabilitySets = {
    base: new Set(baseTools.map((tool) => tool.name)),
    crmOnly: new Set(crmOnlyTools.map((tool) => tool.name)),
    chatOnly: new Set(chatOnlyTools.map((tool) => tool.name)),
  };

  const rows = fullTools.map((tool) => {
    const mode = formatReadWrite(tool);
    const scopes = formatScopes(tool);
    const availability = determineAvailability(tool.name, sets);
    const annotations = formatAnnotations(tool);
    return `| \`${tool.name}\` | ${mode} | ${scopes} | ${availability} | ${annotations} |`;
  });

  const lines = [
    '# Inventário de Ferramentas MCP',
    '',
    '> Arquivo gerado automaticamente por `npm run docs:tools` (`scripts/docs-tools.ts`) a partir de `tools/list` real do servidor (`createServer` com `env` sintético CRM + Chat configurados). Não edite manualmente.',
    '',
    `Total de ferramentas registradas com CRM e Chat configurados: **${fullTools.length}** (sem segredos CRM/Chat: **${baseTools.length}**; apenas CRM: **${crmOnlyTools.length}**; apenas Chat: **${chatOnlyTools.length}**).`,
    '',
    '| Ferramenta | Leitura/Escrita | Escopos (`_meta.securitySchemes`) | Condição de disponibilidade | Anotações MCP |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    '## Notas sobre autorização em tempo de execução',
    '',
    '- A presença de uma ferramenta em `tools/list` não concede permissão OAuth ao cliente chamador.',
    '- `automation_apply_plan`: além de `automation:process` anunciado em `_meta`, o servidor deriva e exige em tempo de execução os escopos CRM (`crm:create`, `crm:enrich` ou `crm:write`) de todos os comandos do plano, além de política em modo `apply`.',
    '- `automation_update_policy`: além de `automation:manage` anunciado em `_meta`, exige os escopos CRM correspondentes às capacidades habilitadas no patch.',
    '- Ferramentas `crm_*` sempre registradas (`crm_*` de leitura e `crm_update_*` legadas) validam escopo OAuth e falham fechadas se `AGENDOR_CRM_TOKEN` não estiver configurado.',
    '',
  ];

  return lines.join('\n');
}

/** Generate and write `docs/tools.md` to disk. */
export async function writeToolsDoc(targetPath = DOCS_TOOLS_PATH): Promise<string> {
  const markdown = await generateToolsMarkdown();
  writeFileSync(targetPath, markdown, 'utf8');
  return markdown;
}

/** Read `docs/tools.md` with normalized LF line endings for cross-platform comparison. */
export function readToolsDoc(targetPath = DOCS_TOOLS_PATH): string {
  return readFileSync(targetPath, 'utf8').replace(/\r\n/g, '\n');
}

if (isEntrypoint(import.meta.url)) {
  writeToolsDoc()
    .then(() => {
      console.log(`Updated ${DOCS_TOOLS_PATH}`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
