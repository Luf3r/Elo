# Scripts NPM e Utilitários Operacionais

Referência vigente dos scripts configurados em `package.json` e dos utilitários TypeScript em `scripts/`, executados diretamente pelo Node (`>=22.19.0`) via *type stripping* nativo.

> Todos os scripts de verificação/OAuth que consultam rede são **opt-in** e nunca executam chamadas remotas ao serem importados em testes.

## Desenvolvimento e build local

| Script (`npm run ...`) | Comando subjacente | Escopo / Rede | Pré-requisitos e uso |
|---|---|---|---|
| `dev` | `wrangler dev` | Local (`127.0.0.1`) | Inicia o Worker localmente com persistência do Wrangler |
| `dev:ephemeral` | `node scripts/dev-ephemeral.ts` | Local (`127.0.0.1:8787`) | Alternativa no Windows sem persistência SQLite (`persist: false`) |
| `build` | `wrangler deploy --dry-run --outdir dist` | Offline (dry-run) | Valida o bundle do Worker sem publicar na Cloudflare |
| `inspector` | `mcp-inspector` | Local | Abre o MCP Inspector oficial para depuração manual |

## Verificação, qualidade e testes

| Script (`npm run ...`) | Comando subjacente | Escopo / Rede | Pré-requisitos e uso |
|---|---|---|---|
| `check` | `format:check && lint && typecheck && test:domain && test:adapters && test:scripts && test:coverage && build` | Offline | Gate obrigatório antes de qualquer commit, release ou merge no CI |
| `format` | `prettier --write src test scripts` | Offline | Aplica formatação Prettier em `src/`, `test/` e `scripts/` |
| `format:check` | `prettier --check src test scripts` | Offline | Verifica aderência ao Prettier sem alterar arquivos |
| `lint` | `eslint .` | Offline | Executa ESLint com checagem de tipos (`src/`, `test/`, `scripts/`) |
| `typecheck` | `tsc --noEmit` | Offline | Verifica tipos TypeScript em `src/`, `scripts/` e `test/` |
| `test` | `vitest run --exclude=test/contract/**` | Offline (hermético) | Suíte principal no runtime `workerd` usando `test/wrangler.jsonc` |
| `test:watch` | `vitest --exclude=test/contract/**` | Offline (hermético) | Modo observação da suíte Vitest principal |
| `test:domain` | `vitest run --config vitest.domain.config.ts` | Offline (Node) | Testes unitários puros de `src/domain/` em ambiente Node puro |
| `test:adapters` | `vitest run --config vitest.adapters.config.ts` | Offline (Node) | Testes unitários de confiabilidade dos adaptadores |
| `test:scripts` | `node --test test/oauth-scripts.test.mjs test/scripts-lib.test.mjs test/chat-contract-script.test.mjs test/oauth-lifetime.node.mjs test/automation-contract-script.test.mjs test/automation-verifier.test.mjs test/release-script.test.mjs test/docs-tools.test.mjs test/readme-sync.test.mjs` | Offline (Node) | Testa helpers/scripts em `scripts/` e a sincronia de [tools.md](../tools.md) e do README com `package.json` |
| `test:coverage` | `vitest run --exclude=test/contract/** --coverage` | Offline (hermético) | Executa a suíte principal com cobertura Istanbul e aplica os limiares mínimos de `src/domain/` e `src/automation/` |
| `test:contract` | `node scripts/run-contract.ts` | Rede real (opt-in) | Carrega `.dev.vars` se existir, define `RUN_AGENDOR_CONTRACT_TESTS=1` e executa `test/contract` (veja [quando executar](#quando-executar-testcontract)) |

## Documentação, release e Cloudflare

| Script (`npm run ...`) | Comando subjacente | Escopo / Rede | Pré-requisitos e uso |
|---|---|---|---|
| `docs:tools` | `node scripts/docs-tools.ts` | Offline | Gera [tools.md](../tools.md) a partir do `tools/list` real do servidor |
| `release` | `node scripts/release.ts` | Offline (Git + `check`) | Valida árvore limpa, tag `vX.Y.Z` no `HEAD` e `npm run check`; imprime o comando de deploy sem publicar |
| `deploy` | `wrangler deploy` | Remoto (Cloudflare) | Publica o Worker; prefira o comando rastreável gerado por `npm run release` |
| `cf:login` | `wrangler login` | Remoto (Cloudflare) | Autentica a sessão local do Wrangler na conta Cloudflare |
| `cf:whoami` | `wrangler whoami` | Remoto (Cloudflare) | Confirma a conta e identidade autenticada no Wrangler |

## OAuth e segredos

| Script (`npm run ...`) | Comando subjacente | Escopo / Rede | Pré-requisitos e uso |
|---|---|---|---|
| `oauth:login` | `node scripts/oauth-login.ts` | Remoto (Cloudflare Access + Worker) | Executa fluxo OAuth PKCE via callback local (`127.0.0.1`), grava URL em `.tooling/oauth-login-url.txt` e salva sessão em `.tooling/oauth-session.json` |
| `oauth:stage-secret` | `node scripts/stage-oauth-secret.ts` | Remoto (Cloudflare) | Lê `ACCESS_CLIENT_SECRET` de `.dev.vars`/ambiente e envia via `stdin` para `wrangler versions secret bulk`, redigindo segredos da saída |

## Verificação remota e descoberta de contratos

| Script (`npm run ...`) | Comando subjacente | Escopo / Rede | Pré-requisitos e uso |
|---|---|---|---|
| `verify:oauth` | `node scripts/verify-oauth.ts` | Remoto (somente leitura) | Valida metadados OAuth (`/.well-known/*`), PKCE S256, CIMD desabilitado e rejeição HTTP `401` em `/mcp` |
| `verify:oauth-renewal` | `node scripts/verify-oauth-renewal.ts` | Remoto (sessão `.tooling/`) | Testa rotação de `refresh_token`, TTL de 24 h / 35 dias, acesso MCP e página de consentimento usando a sessão local |
| `verify:mcp` | `node scripts/verify-mcp.ts` | Remoto (somente leitura) | Executa o `@modelcontextprotocol/inspector` CLI em processo contra `MCP_URL` (padrão produção) com checagem de vazamento de segredos |
| `verify:automation` | `node scripts/verify-automation-mcp.ts` | Offline por padrão (`--read` / `--write` opt-in) | Sem flags retorna `offline` (`remoteCalls: 0`). Com `--read --conversation <id>` roda `preview`; `--write` exige `--analysis` e manifesto `--pilot` válido |
| `verify:chat-contract` | `node scripts/verify-chat-contract.ts` | Remoto (somente leitura) | Lê `AGENDOR_CHAT_TOKEN` de `.dev.vars`, consulta endpoints GET fixos do Chat V1 e emite apenas shapes de schema |
| `discover:automation-contracts` | `node scripts/discover-automation-contracts.ts` | Bloqueado por padrão (`--live` falha fechado) | Observador de contratos somente leitura; no modo CLI exige `--live` e falha fechado enquanto o orçamento compartilhado de DO não estiver disponível |

## Quando executar `test:contract`

O comando `npm run test:contract` (`node scripts/run-contract.ts`) executa `test/contract/` contra serviços reais externos:

- `test/contract/crm.contract.test.ts`: leituras `GET` reais na API Agendor CRM V3 (paginação, campos opcionais, busca vazia, detalhe e `UPSTREAM_NOT_FOUND`).
- `test/contract/chat.contract.test.ts`: leituras `GET` reais na API Agendor Chat V1 (conversas, contadores, detalhe e primeira página de mensagens).
- `test/contract/oauth-upstream.test.ts`: busca do JWKS público do Cloudflare Access e validação de assinatura RS256 no runtime Workers.

**Regra de uso:** `test:contract` **não** participa do `npm run check` nem do CI automático de pushes/PRs porque depende de rede real, credenciais locais (`.dev.vars`) e consome cota real do Agendor. Execute manualmente de forma pontual apenas quando:

1. Houver alteração em adaptadores HTTP, paginação ou schemas de contrato em `src/agendor/crm/`, `src/agendor/chat/` ou na verificação OAuth/JWKS em `src/oauth/identity.ts`.
2. Houver suspeita de quebra ou mudança silenciosa de shape nas APIs externas do Agendor CRM, Agendor Chat ou Cloudflare Access.
3. For necessária validação pontual pré-release após rotação de credenciais ou atualização de dependências de transporte/OAuth, preferencialmente usando conta/ambiente de testes quando disponível.

**Pré-requisitos e cuidados:**

- Configure as credenciais locais no `.dev.vars` (ou variáveis de ambiente): `AGENDOR_CRM_TOKEN`, `AGENDOR_CHAT_TOKEN` + `AGENDOR_CHAT_ACCOUNT_ID`, e `ACCESS_CLIENT_SECRET`. Casos sem credencial configurada são ignorados (`skipIf`).
- Os testes são estritamente somente leitura (`GET`), aplicam pausa de 350 ms entre chamadas e não registram valores de registros em log, mas ainda consomem a cota da conta — não execute em loop nem em paralelo à operação normal.

## Helpers compartilhados (`scripts/lib/`)

- [scripts/lib/args.ts](../../scripts/lib/args.ts): detecção de entrypoint (`isEntrypoint`), parser estrito de opções CLI (`parseCliArgs`), leitura de `.dev.vars` (`parseEnvVars`, `loadLocalDevVars`) e leitura de JSON (`readJsonFile`).
- [scripts/lib/redaction.ts](../../scripts/lib/redaction.ts): coleta de segredos conhecidos (`collectKnownSecrets`), redação em saídas (`redactSecrets`) e falha fechada em caso de vazamento (`containsSecret`, `assertNoSecrets`).
- [scripts/lib/oauth-session.ts](../../scripts/lib/oauth-session.ts): validação estrita do alvo `/mcp` (`validateMcpTarget`) e leitura/gravação segura (`0o600`) da sessão e URL de login em `.tooling/`.
- [scripts/lib/mcp-client.ts](../../scripts/lib/mcp-client.ts): conexão autenticada via `StreamableHTTPClientTransport` (`withMcpClient`) e sondagens `/health` e `401` (`probeHealth`, `assertUnauthorizedMcpRequests`).
