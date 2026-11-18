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
| Variáveis e flags | `AUTOMATION_CHAT_HINTS_ENABLED="false"`, `AGENDOR_CHAT_ACCOUNT_ID="7001"`, endpoints Cloudflare Access OIDC |
| Observabilidade | `enabled: true`, `invocation_logs: false` (não habilite captura de payloads/headers) |
| Secrets obrigatórios | `AGENDOR_CRM_TOKEN`, `ACCESS_CLIENT_SECRET`; opcional para Chat/automação: `AGENDOR_CHAT_TOKEN` |

Preserve os bindings existentes (`OAUTH_KV`, `AUTOMATION_STATE`, filas e secrets); nunca crie outra conta, Worker ou namespace como fallback.

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
   - Passagem integral de `npm run check` (`format:check`, `lint`, `typecheck`, `test`, `test:adapters`, `test:scripts`, `build`).

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
