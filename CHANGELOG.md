# Changelog

Todas as mudanças notáveis de `elo-agendor-mcp` estão documentadas neste arquivo.

## Tabela de versões e implantações Cloudflare

> IDs de versão Cloudflare e datas reconstruídos dos registros de implantação e progresso em [docs/history/](docs/history/README.md). Onde não houve commit isolado na árvore Git, o campo de commit reflete a consolidação registrada no histórico.

| Versão | Commit | ID de versão Cloudflare | Data | Resumo |
|---|---|---|---|---|
| `0.2.1` | `8e027f0` | `af5e44e5-5052-49ad-a8e6-bfe1eef83931` | 2026-11-20 | Atualização conjunta de `agents` 0.33.0 e do SDK do MCP 2.4.0, demais dependências e Actions v7; rollout 10/50/100% a partir do staging |
| `0.2.0` | `d1cf9af` | `0266825f-3774-49c2-a736-3ee1de9f409c` | 2026-11-20 | Taxonomia de erros (quebra para clientes MCP), logs operacionais, remoção de `/automation/chat-events`, configuração de implantação fora do Git e rollout gradual 10/50/100% a partir do staging só leitura |
| `0.1.7` | `9dedbfd` | `816fc83d-752a-405d-87f9-b9cd2c6b0b67` | 2026-11-10 *(commit em 2026-11-17)* | Diagnóstico de `deferred`, trava SQLite por trabalho (`preparation_locks`), status e auditoria de preparação |
| `0.1.6` | *(consolidado em `9dedbfd`)* | `198ce0f1-af14-48ed-986a-68ce04d7a323` | 2026-11-10 | Hotfix do parser de inboxes para coleções `payload`-only abaixo de 100 itens |
| `0.1.5` | *(consolidado em `9dedbfd`)* | `1903e692-2212-4f91-8813-409ac2b2929f` | 2026-11-10 | Validação completa do inventário de inboxes no discovery antes de listar conversas |
| `0.1.4` | *(consolidado em `9dedbfd`)* | `541d46f9-5ed0-477f-9a3e-edbb52eb01da` | 2026-11-10 | Preflight e descoberta incremental (`automation_preflight_sync`, `automation_discover_pending`) em `preview` |
| `0.1.3` | — | *(sem publicação registrada)* | — | Versão intermediária local não publicada entre `0.1.2` e `0.1.4` |
| `0.1.2` | `3bffd37` | `0f9e5f15-6a9b-43e4-a0b9-24aa250cab80` | 2026-11-06 *(commit em 2026-11-09)* | Renovação OAuth com validade de 24h (access) e 35 dias (`offline_access`) |
| `0.1.2` | *(consolidado em `3bffd37`)* | `c53c5538-4cd5-4e09-af92-b6cfc39cb00f` | 2026-11-03 | Correção de schema de metadados de anexos em snapshots de automação |
| `0.1.2` | *(consolidado em `3bffd37`)* | `2b260b00-f1af-4d3e-a4e6-08141ce8db24` | 2026-11-03 | Deploy com política remota `apply` v5 para inboxes `4101`/`4102` e `nativeCreatorDisabled=false` |
| `0.1.2` | *(anterior a `3bffd37`)* | `45325820-bd85-4545-805f-3ae124e288ac` | 2026-10-28 | Confiabilidade Chat → CRM e allowlist exata de redirect S3 para anexos |
| `0.1.2` | `1033c1b` / `56730e3` | `4da0255e-db66-4a85-a19d-346cf60d2ea3` | 2026-10-27 | Rollout técnico da automação com Durable Object, filas e catálogo ampliado (modo `disabled`) |
| `0.1.1` *(histórico 15 ferramentas)* | *(anterior a `2e0e80d`)* | `9a62a3b3-1750-484c-a811-6547efba2611` | Entre 2026-10-22 e 2026-10-26 | Adição das 3 ferramentas iniciais somente leitura do Agendor Chat (`chat:read`) |
| `0.1.0` *(OAuth)* | `d4efaa3` / `1a76ace` | `48f65d8d-d1b9-4d83-8102-e2f46f5b36e6` | 2026-10-21 | OAuth 2.1 via Cloudflare Access OIDC (PKCE S256, `OAUTH_KV`, JWKS `redirect: manual`) |
| `0.1.0` *(MVP)* | `fa4b908` | `7e6bdf1d-9f39-4435-959d-b000e1c0674f` | 2026-10-21 | Publicação inicial com leituras CRM e autenticação por token de teste (descontinuada) |

## [Não publicado]

- **Leitura limitada de corpo**: `limitedText` (OAuth), `fetchJson` (HTTP), o transporte do Chat e o download de anexos usam `readBoundedBody`, sem mudança de respostas.
- **Lint e sincronia documental**: `max-lines` passa a ser erro global (exceto em `test/`), sem entrada duplicada; `test/docs-consistency.test.mjs` impede que a documentação vigente volte a tratar valores de exemplo como da implantação.
- **Correção de comportamento da fila**: `queue_message_dead_lettered` só ocorre com `attempts > 4`, na 5ª entrega, que é quando a mensagem vai de fato para a DLQ. Operações `queued` e `uncertain` continuam esperando com `message.retry` e `delaySeconds` (`queue_message_rescheduled`); na 5ª entrega são confirmadas com `ack` (`queue_message_parked`) em vez de irem para a DLQ, e o watchdog as entrega de novo. Cada cadeia de entregas fica limitada a 5, sem reenvio por `AUTOMATION_QUEUE.send` que se perpetuaria a cada passagem do watchdog. Corpos inválidos geram `queue_message_malformed`.
- **Sincronia de configuração**: `test/queue-config-sync.test.mjs` falha se `QUEUE_MAX_RETRIES` divergir do `max_retries` dos consumidores em `wrangler.example.jsonc`.
- **CI**: o workflow `CI` roda com `permissions: contents: read`, e `.agent-runs/` entra no `.gitignore`, como já estava nos ignores do ESLint.
- **Observabilidade**: `errorFields` pode registrar `errorSite` com a primeira linha do stack, redigida e limitada a 200 caracteres, sem incluir a mensagem do erro.
- **Observabilidade OAuth**: novos avisos `oauth_identity_exchange_failed`, `oauth_consent_failed` e `oauth_callback_failed` registram falhas diagnósticas sanitizadas.
- **Arquitetura interna**: `isConfiguredSecret` foi centralizada em `src/shared/secrets.ts`; `timingSafeTokenEqual` e `enforceCrmRateLimit`/`enforceChatRateLimit` foram removidas. `src/shared` não pode importar camadas de automation, domain, agendor, mcp ou oauth, e o orçamento usa `BUDGET_WINDOW_MS`/`BUDGET_MAX_RESERVATIONS`.
- **Cobertura**: adicionados pisos para `src/oauth`, `src/mcp`, `src/agendor` e `src/shared` em `vitest.config.ts`.
- **Suíte de testes**: um alarme de manutenção deixado por operações `queued` ou `uncertain` podia disparar após o teste e causar `EnvironmentTeardownError` durante o fechamento do ambiente Workers. Os alarmes de todas as instâncias de `AUTOMATION_STATE` agora são removidos após cada teste, e `test/reliability/vitest-config.test.ts` protege essa configuração contra o ocultamento de erros não tratados. O código de produção e as asserções existentes não mudaram.
- **Sincronia documental**: `test/readme-sync.test.mjs` verifica a versão e os passos de `npm run check` no `README.md` e no `AGENTS.md`.
- **Documentação**: referências à configuração de tenant e à allowlist agora apontam para `__ELO_DEPLOYMENT__` ou rotulam os exemplos de `test/wrangler.jsonc`; corrigidos o link do modelo de contexto histórico e as regras de camada do lint; registrado o estado de 2026-11-23 com os itens #13 e #14 concluídos e a Fase 9 em andamento.
- **Registro de ferramentas (`tools/list`)** — mudança de contrato para implantações parcialmente configuradas, entra no 0.3.0: uma ferramenta só aparece quando as credenciais da integração estão configuradas. Sem segredos, a lista passa de 15 para 1 ferramenta; apenas Chat, de 23 para 9; apenas CRM permanece em 23 e CRM + Chat permanece em 44. Em produção, com CRM e Chat configurados, nada muda.

## [0.2.1] — 2026-11-20

- **Dependências**: `agents` 0.29.0 → 0.33.0 junto com `@modelcontextprotocol/server` e `@modelcontextprotocol/client` 2.3.1 → 2.4.0 (o `agents` fixa a versão exata do SDK do MCP, por isso sobem juntos; o SDK v1 e o express saem da árvore). Também `jose` 6.2.17, `@cloudflare/workers-oauth-provider` 1.2.4, `wrangler` 4.163.0, `@cloudflare/vitest-plugin` 1.8.3, `@cloudflare/workers-types` 5.20261117.1, `@modelcontextprotocol/inspector` 2.15.0, `@types/node` 26.6.6 e `actions/checkout`/`actions/setup-node` v7 nos workflows.
- **Dependabot**: novo grupo `mcp-stack` para `agents` e `@modelcontextprotocol/*`, que agora são atualizados sempre no mesmo PR.

## [0.2.0] — 2026-11-20

> **QUEBRA DE COMPATIBILIDADE** na taxonomia de erros MCP (Fase 4): clientes avisados antes da publicação em 2026-11-20. Rollout gradual a partir do staging só leitura: 10%, 50% e 100% da versão `0266825f`, sem erros nas invocações.

- **Fase 0 — Rede de segurança (`803f5fa`)**: configuração hermética de testes em `test/wrangler.jsonc`, correção de falhas preexistentes na suíte (`P4`/`P5`), alteração da listagem de auditoria (`AuditRepository.listAudit` / `automation_list_audit`) para ordem mais recente primeiro (`ORDER BY occurred_at DESC, audit_id DESC`) com paginação por `cursor`, script `npm run check`, workflow de CI em `.github/workflows/ci.yml`, `scripts/release.ts` (migrado na Fase 7) e exposição de `commit` em `/health` e `server_status`.
- **Fase 1 — Formatação e lint (`e30d911`, `2ff4995`, `eea14bb`)**: Prettier + ESLint type-aware (`no-floating-promises`, `no-misused-promises`, regras de fronteira de camadas) integrados ao `npm run check`.
- **Fase 2 — Documentação**: gerador `scripts/docs-tools.ts` (`npm run docs:tools`, migrado na Fase 7) com teste de sincronia, reescrita do `README.md`, documentação vigente de arquitetura, segurança, operações, integrações e ADRs, `CHANGELOG.md`, `AGENTS.md` e organização histórica em `docs/history/`.
- **Fase 3 — Reestruturação**:
  - Camada de domínio pura extraída para `src/domain/` (identidade, demandas, planejador, campos, estágios, política, autorização e revisões), sem dependências de IO, `env`, `fetch` ou Durable Object.
  - Portas de adaptadores definidas em `src/agendor/ports.ts` (`BudgetGate` e `InboxGuard`), injetadas na criação dos clientes Agendor e removendo imports de `src/agendor/` para `src/automation/` ou `src/domain/` (C5).
  - Divisão do repositório monolítico em repositórios por agregado em `src/automation/state/repositories/` (`audit.ts`, `commands.ts`, `context.ts`, `customers.ts`, `discovery.ts`, `plans.ts`, `reviews.ts`, `work.ts`) e dos casos de uso em `src/automation/usecases/` (`apply.ts`, `audit.ts`, `context.ts`, `discover.ts`, `policy.ts`, `preflight.ts`, `prepare.ts`, `prepare-hydration.ts`, `prepare-steps.ts`, `reprocess.ts`, `reviews.ts`, `status.ts`, `submit.ts`), com schemas separados em `src/domain/schemas/` e configuração do tenant centralizada em `src/app/config/tenant.ts` (C3, C4, C12).
  - Migrations SQLite declarativas (`src/automation/state/migrations.ts`, lista `Migration[]` + `runMigrations` transacional, versões 1–8) verificadas por testes de caracterização e upgrade (C9).
  - Leitura validada de JSON persistido via `readJson(schema, text, label)` em `src/shared/json.ts` (lançando `CorruptedJsonError`) no lugar de `JSON.parse(...) as T` (C8), e promoção das regras de fronteira de camadas no ESLint para erro.
- **Fase 4 — Erros e observabilidade — QUEBRA DE COMPATIBILIDADE (`0.2.0`)**:
  - **Quebra de compatibilidade para clientes MCP (`ChatGPT`, `Zapia`)**: separação explícita entre falha de identidade/escopo OAuth, bloqueio por política operacional, trabalho/cursor obsoleto e conflito de payload/idempotência em `src/shared/errors.ts`, com atualização das descrições e instruções do servidor MCP (`POLICY_BLOCKED`, `WORK_STALE` e `CONFLICT`). Clientes que inspecionavam `error.code` precisam adotar os novos códigos abaixo:

    | Situação | Antes | Depois | HTTP |
    |---|---|---|---|
    | Bloqueio por política (`mode`, escopo de preparação/aplicação ou inbox fora da allowlist `4101`/`4102`) | `MCP_UNAUTHORIZED` | `POLICY_BLOCKED` | `403` |
    | Ausência de identidade ou escopo OAuth (`src/auth.ts`, `automationActor`) | `MCP_UNAUTHORIZED` | `MCP_UNAUTHORIZED` | `403` |
    | Trabalho, estado de preparação, conversa ou cursor de descoberta obsoleto/expirado | `INVALID_INPUT` | `WORK_STALE` | `409` |
    | Conflito de `requestId` com payload ou ator divergente | `INVALID_INPUT` | `CONFLICT` | `409` |

  - **Logger estruturado e pontos de entrada (`src/shared/logger.ts`)**: emissão via `logEvent` e `errorFields` de objeto único indexável pelo Workers Logs, com redação automática de campos sensíveis e padrões de PII/token, omissão de objetos/arrays aninhados e extração de erros sem `error.message`:
    - `auth_service_unavailable` (`error`, `src/index.ts`) no `503` de autenticação sem query string;
    - `unexpected_error` (`error`, `src/mcp/result.ts`) apenas para erros fora de `SafeError`;
    - `oauth_authorization_failed` (`warn`, `src/oauth/handler.ts`) em falhas de autorização OAuth;
    - `mcp_request_failed` (`error`, `src/oauth/provider.ts`) no `catch` do `apiHandler` de `/mcp` para erros fora de `SafeError`;
    - `queue_message_retry` (`warn`, `src/automation/execution/queue.ts`) quando `handleAutomationQueue` agenda retry (`attempts < 4`);
    - `queue_message_dead_lettered` (`error`, `src/automation/execution/queue.ts`) na 4ª tentativa antes do envio à DLQ;
    - `watchdog_failed` (`error`, `src/index.ts`) quando o handler `scheduled` falha ao executar `maintainAccount`.
- **Fase 5.1 — Remoção do token fixo (`1f767cc`)**: remoção definitiva de `MCP_TEST_TOKEN` e do script `scripts/setup-local-token.mjs` (C10).
- **Fase 5.2 — Remoção de `/automation/chat-events` e endurecimento OAuth**:
  - Remoção do endpoint não assinado `/automation/chat-events` e da flag `AUTOMATION_CHAT_HINTS_ENABLED` (C11).
  - Rotas OAuth (`/authorize`, `/callback`, `/token`, `/token/revoke`, `/register`) sem cabeçalho `CF-Connecting-IP` passam a responder HTTP `429` (`temporarily_unavailable`, `Retry-After: 10`, `Cache-Control: no-store`) antes de consultar `OAUTH_RATE_LIMITER`.
- **Fase 6 — Testes**:
  - Suíte unitária pura de domínio em ambiente Node (`vitest.domain.config.ts`, `npm run test:domain`) desacoplada do runtime `workerd`.
  - Builders de fixture em `test/fixtures/builders.ts` e fixtures dedicadas em `test/fixtures/` substituindo objetos literais repetidos.
  - Cobertura Istanbul (`npm run test:coverage` em `vitest.config.ts`) com limiares mínimos exigidos no CI para `src/domain/**/*.ts` e `src/automation/**/*.ts`.
  - Testes de propriedade com `fast-check` (`test/domain/properties.test.ts`) cobrindo idempotência e invariantes de `normalizeName`, `normalizeEmail`, `normalizeDocument`, `normalizedPhone`, `canonical` e `payloadDigest`.
- **Fase 7 — Scripts em TypeScript**:
  - Migração dos utilitários `scripts/*.mjs` para TypeScript (`scripts/*.ts`) executados diretamente pelo Node (`>=22.19.0`) via *type stripping*, com helpers compartilhados em `scripts/lib/` (`args.ts`, `redaction.ts`, `oauth-session.ts`, `mcp-client.ts`) e catálogo atualizado em `docs/operations/scripts.md`.
- **Observabilidade (Fase 4.3)**: `invocation_logs` ligado e quatro consultas salvas no Workers Observability (eventos, falhas inesperadas, fila e DLQ, erros por código).
- **Contrato no CI (Fase 6.5)**: workflow manual `Agendor contract` com os segredos do environment `contract`; `test:contract` usa `wrangler.example.jsonc` quando não há `wrangler.jsonc` local.
- **Staging só leitura e rollout gradual (Fase 8)**: ambiente `staging` com recursos próprios e `readOnly: true` em `__ELO_DEPLOYMENT__`; nesse modo o OAuth só concede escopos de leitura e cada requisição descarta os demais escopos do token. `npm run release` passa a imprimir staging, `wrangler versions upload` e `versions deploy` em 10%, 50% e 100%; o deploy direto usa `--env=""`.
- **Versão 0.2.0** em `package.json`, por causa da quebra de códigos de erro da Fase 4.
- **Configuração de implantação fora do Git**: origem, e-mail do dono, chave do tenant e allowlist de inbox vêm do define `__ELO_DEPLOYMENT__` (`src/app/config/deployment.ts`, fail-closed). O `wrangler.jsonc` real deixa de ser versionado; o repositório traz `wrangler.example.jsonc`, e `npm run build` usa o arquivo local quando existe e o exemplo nos demais casos (CI, clones novos).

## [0.1.7] — 2026-11-10

- Adicionada trava SQLite por trabalho (`preparation_locks`, migration 8, expiração de 60 s) evitando execuções paralelas sobre o mesmo trabalho.
- Aprimoramento de `deferred` com código sanitizado, progresso por fase, contagem de tentativas sem avanço (bloqueio após 5 sem progresso) e `retryAt`.
- Páginas de mensagens com identidade ou cursor inválido passam a ser encaminhadas para revisão antes das consultas CRM.
- Auditoria operacional e status de preparação detalhados por identidade OAuth.

## [0.1.6] — 2026-11-10

- Hotfix no parser de inventário de inboxes para aceitar coleções `{ payload: [...] }` sem `links` quando abaixo de 100 registros, mantendo bloqueio em 100 itens, links pendentes, duplicatas ou caixas inesperadas.

## [0.1.5] — 2026-11-10

- Reforço no preflight e discovery da T01 exigindo validação completa do inventário de inboxes da conta (`4101` e `4102`) antes de listar conversas.

## [0.1.4] — 2026-11-10

- Introdução de `automation_preflight_sync` e `automation_discover_pending` com cursor opaco persistido em SQLite (`pending_cursors`, `pending_activity`, migration 7) para descoberta incremental em `preview`.

## [0.1.3] — *(não publicada)*

- Transição interna de versão entre `0.1.2` e `0.1.4`, sem publicação registrada na Cloudflare.

## [0.1.2] — 2026-10-27 a 2026-11-06

- **Automação Chat → CRM e Durable Object**: introdução de `AutomationAccount` (SQLite com migrations 1–6), fila `elo-agendor-operations` e DLQ, watchdog cron `*/5 * * * *`, gate de orçamento compartilhado (`takeBudget` 4 req/10s por produto), contexto Markdown versionado por cliente (32 KiB), criação/enriquecimento CRM com `requestId` e reconciliação.
- **Confiabilidade Chat → CRM**: allowlist fixa `4101`/`4102` fail-closed, paginação de mensagens por `after`, filtro `status=all` por padrão, downloads de anexos até 20 MiB em partes de 192 KiB com SHA-256 e origem S3 exata permitida, prioridade ao vínculo direto `crmPersonId` e bloqueio de criação normal de pessoas enquanto `nativeCreatorDisabled` não for verdadeiro.
- **Renovação OAuth**: `accessTokenTTL` ajustado para 24h e `refreshTokenTTL` de 35 dias condicionado ao consentimento de `offline_access`.

## [0.1.1] — *(histórico intermediário)*

- Expansão do catálogo inicial de 8/12 para 15 ferramentas com os três leitores iniciais do Agendor Chat (`chat_list_conversations`, `chat_get_conversation`, `chat_list_messages`) sob `chat:read`.

## [0.1.0] — 2026-10-21

- **MVP inicial**: Worker stateless com endpoint `/health`, autenticação inicial por token fixo (posteriormente removida), leituras tipadas e atualizações limitadas do Agendor CRM V3, propagação de cancelamento e suíte inicial no `vitest-plugin`.
- **OAuth 2.1 com Cloudflare Access**: substituição da autenticação estática por `@cloudflare/workers-oauth-provider`, validação OIDC RS256 via JWKS do Cloudflare Access (One-time PIN para o proprietário), PKCE S256 obrigatório e `OAUTH_KV`.
