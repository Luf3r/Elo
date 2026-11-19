# Changelog

Todas as mudanças notáveis de `elo-agendor-mcp` estão documentadas neste arquivo.

## Tabela de versões e implantações Cloudflare

> IDs de versão Cloudflare e datas reconstruídos dos registros de implantação e progresso em [docs/history/](docs/history/README.md). Onde não houve commit isolado na árvore Git, o campo de commit reflete a consolidação registrada no histórico.

| Versão | Commit | ID de versão Cloudflare | Data | Resumo |
|---|---|---|---|---|
| `0.1.7` | `07473e3` | `816fc83d-752a-405d-87f9-b9cd2c6b0b67` | 2026-11-10 *(commit em 2026-11-17)* | Diagnóstico de `deferred`, trava SQLite por trabalho (`preparation_locks`), status e auditoria de preparação |
| `0.1.6` | *(consolidado em `07473e3`)* | `198ce0f1-af14-48ed-986a-68ce04d7a323` | 2026-11-10 | Hotfix do parser de inboxes para coleções `payload`-only abaixo de 100 itens |
| `0.1.5` | *(consolidado em `07473e3`)* | `1903e692-2212-4f91-8813-409ac2b2929f` | 2026-11-10 | Validação completa do inventário de inboxes no discovery antes de listar conversas |
| `0.1.4` | *(consolidado em `07473e3`)* | `541d46f9-5ed0-477f-9a3e-edbb52eb01da` | 2026-11-10 | Preflight e descoberta incremental (`automation_preflight_sync`, `automation_discover_pending`) em `preview` |
| `0.1.3` | — | *(sem publicação registrada)* | — | Versão intermediária local não publicada entre `0.1.2` e `0.1.4` |
| `0.1.2` | `540d098` | `0f9e5f15-6a9b-43e4-a0b9-24aa250cab80` | 2026-11-06 *(commit em 2026-11-09)* | Renovação OAuth com validade de 24h (access) e 35 dias (`offline_access`) |
| `0.1.2` | *(consolidado em `540d098`)* | `c53c5538-4cd5-4e09-af92-b6cfc39cb00f` | 2026-11-03 | Correção de schema de metadados de anexos em snapshots de automação |
| `0.1.2` | *(consolidado em `540d098`)* | `2b260b00-f1af-4d3e-a4e6-08141ce8db24` | 2026-11-03 | Deploy com política remota `apply` v5 para inboxes `4101`/`4102` e `nativeCreatorDisabled=false` |
| `0.1.2` | *(anterior a `540d098`)* | `45325820-bd85-4545-805f-3ae124e288ac` | 2026-10-28 | Confiabilidade Chat → CRM e allowlist exata de redirect S3 para anexos |
| `0.1.2` | `0484034` / `ae860b8` | `4da0255e-db66-4a85-a19d-346cf60d2ea3` | 2026-10-27 | Rollout técnico da automação com Durable Object, filas e catálogo ampliado (modo `disabled`) |
| `0.1.1` *(histórico 15 ferramentas)* | *(anterior a `fd77c9d`)* | `9a62a3b3-1750-484c-a811-6547efba2611` | Entre 2026-10-22 e 2026-10-26 | Adição das 3 ferramentas iniciais somente leitura do Agendor Chat (`chat:read`) |
| `0.1.0` *(OAuth)* | `be859b5` / `27a1c17` | `48f65d8d-d1b9-4d83-8102-e2f46f5b36e6` | 2026-10-21 | OAuth 2.1 via Cloudflare Access OIDC (PKCE S256, `OAUTH_KV`, JWKS `redirect: manual`) |
| `0.1.0` *(MVP)* | `dac8072` | `7e6bdf1d-9f39-4435-959d-b000e1c0674f` | 2026-10-21 | Publicação inicial com leituras CRM e autenticação por token de teste (descontinuada) |

## [Não publicado]

- **Fase 0 — Rede de segurança (`c2f2518`)**: configuração hermética de testes em `test/wrangler.jsonc`, correção de falhas preexistentes na suíte (`P4`/`P5`), script `npm run check`, workflow de CI em `.github/workflows/ci.yml`, `scripts/release.mjs` e exposição de `commit` em `/health` e `server_status`.
- **Fase 1 — Formatação e lint (`a0b4ad3`, `062b4d7`, `f4431fb`)**: Prettier + ESLint type-aware (`no-floating-promises`, `no-misused-promises`, regras de fronteira de camadas) integrados ao `npm run check`.
- **Fase 5.1 — Remoção do token fixo (`61c9fae`)**: remoção definitiva de `MCP_TEST_TOKEN` e `scripts/setup-local-token.mjs` (C10).
- **Fase 2 — Documentação**: gerador `scripts/docs-tools.mjs` (`npm run docs:tools`) com teste de sincronia, reescrita do `README.md`, documentação vigente de arquitetura, segurança, operações, integrações e ADRs, `CHANGELOG.md`, `AGENTS.md` e organização histórica em `docs/history/`.
- **Fase 4.2 (parte 1) — Logger estruturado**: adicionado `src/shared/logger.ts` (`logEvent` e `errorFields`) emitindo um único objeto indexável pelo Workers Logs com redação automática de campos sensíveis e padrões de PII/token, omissão de objetos/arrays aninhados e extração de erros sem mensagem.

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
