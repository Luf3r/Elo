# Procedimento de Deploy e Release

Este guia descreve o procedimento vigente para publicar o Worker `elo-agendor-mcp` na Cloudflare.

## Recursos configurados (`wrangler.jsonc`)

| Recurso | Configuração vigente |
|---|---|
| Worker e origem | `elo-agendor-mcp` — `https://elo-agendor-mcp.example.workers.dev` (`/mcp`, `/health`) |
| Runtime | `compatibility_date: "2026-10-21"`, `nodejs_compat`, `global_fetch_strictly_public` |
| KV OAuth | `OAUTH_KV` (`00000000000000000000000000000000`) |
| Durable Object | `AUTOMATION_STATE` → classe SQLite `AutomationAccount` (migração `automation-v1`) |
| Fila e DLQ | `AUTOMATION_QUEUE` → `elo-agendor-operations` (`max_batch_size: 1`, `max_concurrency: 1`, `max_retries: 4`); DLQ `elo-agendor-operations-dlq` |
| Cron watchdog | `*/5 * * * *` |
| Rate limiters | `MCP_RATE_LIMITER` (`1001`, 30/10s) e `OAUTH_RATE_LIMITER` (`1003`, 30/10s) |
| Variáveis e flags | `AGENDOR_CHAT_ACCOUNT_ID="7001"`, endpoints Cloudflare Access OIDC |
| Observabilidade | `enabled: true`, `invocation_logs: false` (não habilite captura de payloads/headers) |
| Secrets obrigatórios | `AGENDOR_CRM_TOKEN`, `ACCESS_CLIENT_SECRET`; opcional para Chat/automação: `AGENDOR_CHAT_TOKEN` |

Preserve os bindings existentes (`OAUTH_KV`, `AUTOMATION_STATE`, filas e secrets); nunca crie outra conta, Worker ou namespace como fallback.

## Configuração de implantação

O `wrangler.jsonc` real de cada implantação fica fora do Git e parte de `wrangler.example.jsonc`. Além do nome do Worker (`name`), dos bindings de `OAUTH_KV` e `AUTOMATION_STATE` (classe SQLite `AutomationAccount`, migração `automation-v1`), das filas (`AUTOMATION_QUEUE` e DLQ) e dos rate limiters (`MCP_RATE_LIMITER` e `OAUTH_RATE_LIMITER`), ele deve preencher:

- **Variáveis (`vars`)**: `AGENDOR_CHAT_ACCOUNT_ID` (ID numérico da conta no Agendor Chat) e os parâmetros Cloudflare Access OIDC (`ACCESS_CLIENT_ID`, `ACCESS_ISSUER`, `ACCESS_AUTHORIZATION_URL`, `ACCESS_TOKEN_URL`, `ACCESS_JWKS_URL`, todos em `https://*.cloudflareaccess.com` consistentes com o emissor e `ACCESS_CLIENT_ID`).
- **Configuração injetada no build (`define.__ELO_DEPLOYMENT__`)**: objeto JSON serializado validado de forma estrita (`z.strictObject`) em `src/app/config/deployment.ts`, exigindo exatamente quatro campos (ex.: `{"origin":"https://elo.example.workers.dev","ownerEmail":"owner@example.com","tenantKey":"acme","allowedInboxIds":[101,102]}`):
  - `origin`: URL `https://` válida, sem espaços, porta explícita, credenciais, path além de `/`, query string ou fragmento (normalizada para `origin`).
  - `ownerEmail`: endereço de e-mail válido do proprietário autorizado para OAuth/Access.
  - `tenantKey`: identificador do tenant casando com `^[a-z][a-z0-9-]{0,31}$` (1 a 32 caracteres).
  - `allowedInboxIds`: lista de 1 a 50 inteiros positivos seguros, sem duplicatas, imutável em tempo de execução.

Configuração ausente, com chaves extras ou inválida derruba o Worker na inicialização (*fail-closed*).

> [!WARNING]
> **Nunca altere `name` (nome do Worker) nem `tenantKey` em uma implantação existente.** Mudar qualquer um deles cria outro Worker ou outra instância do Durable Object (`env.AUTOMATION_STATE.getByName(tenantKey)`), deixando todo o estado atual (política, leases, operações, contexto e auditoria) órfão. Além disso, `tenantKey` é gravado nos marcadores HTML do CRM (`<!-- <tenantKey>:auto:start -->` / `<!-- <tenantKey>:auto:end -->`) e compõe os valores aceitos de `approach` e `actor` nos schemas e ferramentas de automação.

## Fluxo de release rastreável

1. Verifique que a árvore Git está limpa, que `package.json` possui a versão `X.Y.Z` desejada e que a tag anotada/leve `vX.Y.Z` aponta exatamente para o `HEAD`:

   ```bash
   git status
   git tag vX.Y.Z
   ```

2. Execute o preparador de release (`scripts/release.ts`):

   ```bash
   npm run release
   ```

   O script valida:
   - Árvore de trabalho limpa (`git status --porcelain` vazio);
   - Existência da tag `vX.Y.Z` apontando para o `HEAD` atual;
   - Passagem integral de `npm run check` (`format:check`, `lint`, `typecheck`, `test:domain`, `test:adapters`, `test:scripts`, `test:coverage`, `build`).

   Ao passar, `npm run release` **não faz deploy automaticamente**; ele imprime o comando exato de publicação com `__BUILD_COMMIT__` injetado e `--tag` / `--message` rastreáveis.

3. Caso precise autenticar o Wrangler ou atualizar o secret do Access antes da publicação:

   ```bash
   npm run cf:whoami
   npm run oauth:stage-secret
   ```

   `oauth:stage-secret` envia `ACCESS_CLIENT_SECRET` via `stdin` (sem expor valores em argumentos) e cria uma versão intermediária sem tráfego; o deploy seguinte herda os secrets da versão mais recente.

4. Execute manualmente o comando `npx wrangler deploy ...` impresso por `npm run release` após aprovação explícita de publicação.

## Verificação pós-deploy (smoke check)

1. Confirme `GET https://elo-agendor-mcp.example.workers.dev/health` retornando HTTP `200` com `status: "ok"`, `version` igual a `package.json` e `commit` igual ao `HEAD` publicado.
2. Com sessão OAuth válida (`npm run oauth:login` quando necessário, armazenada apenas em `.tooling/` ignorado), execute:

   ```bash
   npm run verify:oauth
   npm run verify:mcp
   ```

3. No cliente MCP autenticado, consulte `server_status` e `automation_get_status` para confirmar `policyVersion`, modo vigente e ausência de operações/revisões inesperadas.
4. A política de aplicação reside no Durable Object `AutomationAccount` e **não** é redefinida pelo deploy de código (nunca assuma que um deploy redefine ou ativa a política).
5. Caso o release tenha alterado adaptadores Agendor ou validação OAuth/JWKS, avalie a execução manual e pontual de `npm run test:contract` conforme [scripts.md](scripts.md#quando-executar-testcontract).

## Rollback por versão

Antes de executar rollback, siga as pré-condições de segurança descritas em [recovery.md](recovery.md#5-rollback-de-código): pause a automação (`automation_update_policy` com `mode: "disabled"`), inspecione pendências `queued`/`uncertain`, verifique compatibilidade da versão alvo com o schema atual de `schema_migrations` em `AutomationAccount` e com o formato da fila, e nunca remova a classe `AutomationAccount` nem recrie `OAUTH_KV`.

1. **Identificar a versão atual e a versão alvo**:
   - Consulte `GET /health` e a ferramenta MCP `server_status` para confirmar `version` e `commit` atualmente servidos em produção (veja também o histórico de publicações em [CHANGELOG.md](../../CHANGELOG.md#tabela-de-versões-e-implantações-cloudflare)).
   - Liste as versões registradas na Cloudflare:

     ```bash
     npx wrangler versions list
     ```

   - Localize o `<version-id>` desejado pela tag e mensagem gravadas por `npm run release` (`--tag vX.Y.Z` e `--message "Release vX.Y.Z (<commit>)"`), conferindo que o hash de commit corresponde ao da tag Git esperada e aos campos `version` / `commit` expostos em `/health` e `server_status`.

2. **Reverter a versão ativa**:
   - Execute `wrangler rollback` apontando para o ID da versão alvo:

     ```bash
     npx wrangler rollback <version-id>
     ```

   - Como alternativa equivalente para promover integralmente uma versão já enviada:

     ```bash
     npx wrangler versions deploy <version-id>@100%
     ```

   > Rollback de código não redefine a política persistida no Durable Object `AutomationAccount` nem desfaz empresas, pessoas, negócios ou tarefas já gravados no Agendor CRM.

3. **O que conferir depois do rollback**:
   - Confirme `GET https://elo-agendor-mcp.example.workers.dev/health` retornando HTTP `200` com `status: "ok"` e os valores de `version` e `commit` da versão restaurada.
   - Execute `npm run verify:oauth` e `npm run verify:mcp` para validar OAuth e catálogo MCP.
   - No cliente MCP autenticado, consulte `server_status` (confirmando `version` e `commit`) e `automation_get_status` (confirmando `policyVersion`, `mode` e ausência de erros inesperados).
   - Acompanhe os Workers Logs para confirmar ausência de `auth_service_unavailable`, `mcp_request_failed`, `unexpected_error`, `queue_message_retry`, `queue_message_dead_lettered` ou `watchdog_failed`.
