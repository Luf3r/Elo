# Rotação de Segredos e Gestão OAuth

Procedimento vigente para rotação de credenciais, renovação e revogação de concessões OAuth no `elo-agendor-mcp`.

## Segredos do Worker

| Secret | Obrigatoriedade | Origem |
|---|---|---|
| `AGENDOR_CRM_TOKEN` | Obrigatório (`secrets.required`) | Token da conta no Agendor CRM |
| `ACCESS_CLIENT_SECRET` | Obrigatório (`secrets.required`) | Secret OIDC da aplicação SaaS no Cloudflare Access |
| `AGENDOR_CHAT_TOKEN` | Obrigatório para Chat/automação | Token da conta `7001` no Agendor Chat |

> Nunca passe valores de segredos em argumentos de linha de comando, URLs, logs ou arquivos versionados. Mantenha cópia local exclusivamente no `.dev.vars` ignorado pelo Git.

### Rotação de `ACCESS_CLIENT_SECRET`

1. No painel Cloudflare Zero Trust, acesse a aplicação OIDC configurada (`Elo Agendor MCP`), gere/redefina o Client Secret e atualize `ACCESS_CLIENT_SECRET` no `.dev.vars` local.
2. Envie o novo valor via `stdin` para o Worker sem alterar tráfego imediato:

   ```bash
   npm run oauth:stage-secret
   ```

3. Publique ou conclua o ciclo de release conforme [deploy.md](deploy.md) para que a versão ativa herde o secret.
4. Valide o fluxo completo:

   ```bash
   npm run verify:oauth
   npm run oauth:login
   npm run verify:mcp
   ```

### Rotação de `AGENDOR_CRM_TOKEN` e `AGENDOR_CHAT_TOKEN`

1. Gere o novo token no painel correspondente do Agendor e atualize o `.dev.vars` local.
2. Envie o secret interativamente pelo Wrangler (nunca em argumento):

   ```bash
   npx wrangler secret put AGENDOR_CRM_TOKEN
   # ou
   npx wrangler secret put AGENDOR_CHAT_TOKEN
   ```

3. Execute smoke checks somente leitura autenticados (`server_status` e uma consulta CRM/Chat autorizada) para confirmar que o novo token responde sem erro `401`/`403`.

## Ciclo de vida, renovação e revogação OAuth

- **Access tokens**: validade de **24 horas** (`ACCESS_TOKEN_TTL_SECONDS`).
- **Refresh tokens**: validade de **35 dias** a partir do login inicial, emitidos somente quando `offline_access` é aprovado na tela de consentimento (a tela de consentimento inclui `offline_access` explicitamente para clientes compatíveis como ChatGPT Plus e Zapia).
- **Clientes independentes**: ChatGPT Plus, Zapia e verificadores locais recebem `clientId` e concessões independentes via registro dinâmico (`/register`, TTL de 90 dias).
- **Renovação**: ocorre no endpoint `/token` com `grant_type=refresh_token` e o mesmo `client_id`. Renovar o access token **não reinicia** o prazo de 35 dias; ao expirar, refaça o login via PIN do Cloudflare Access na página oficial da Cloudflare.
- **Verificação de renovação**: `node scripts/verify-oauth-renewal.mjs` testa o ciclo de refresh usando exclusivamente a sessão local ignorada em `.tooling/`, sem exibir tokens nem alterar registros no Agendor.
- **Revogação**:
  - Por cliente/token: utilize o endpoint `/token/revoke` ou as APIs administrativas `OAuthHelpers` da biblioteca. Lembre-se de que `OAUTH_KV` possui consistência eventual — não prometa revogação global instantânea no milissegundo seguinte.
  - Em emergência (comprometimento ou suspensão total imediata): retire a publicação do endpoint ou restaure uma versão controlada enquanto revoga as concessões em `OAUTH_KV`. **Nunca** tente restaurar autenticação por token fixo como contorno de login.
