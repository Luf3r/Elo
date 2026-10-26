# Elo Agendor Remote MCP

Worker TypeScript para consultar e atualizar campos permitidos do Agendor CRM e ler conversas do Agendor Chat, com Streamable HTTP em `/mcp` e `GET /health` público.

Endpoint: [MCP](https://elo-agendor-mcp.example.workers.dev/mcp) e [saúde pública](https://elo-agendor-mcp.example.workers.dev/health). A implementação OAuth conecta ChatGPT Plus e Zapia por autorização no navegador e código enviado ao e-mail do proprietário. Estado da publicação e evidências em [deployment](docs/deployment.md); instruções em [OAuth](docs/oauth-setup.md). Não inclua credenciais na URL.

Requer Node >=22.19.0. Execute `npm ci`, copie `.dev.vars.example` para `.dev.vars`, preencha `AGENDOR_CRM_TOKEN` e `ACCESS_CLIENT_SECRET` localmente e execute `npm run dev`. Os endpoints OIDC públicos e os bindings ficam em `wrangler.jsonc`. Nunca envie tokens no chat nem use `vars` do Wrangler para credenciais. `MCP_TEST_TOKEN` não autentica a implementação OAuth.

## Dependências verificadas

Em 2026-10-21, a [documentação oficial](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/) recomenda `createMcpHandler` com uma factory que cria um novo servidor por requisição. O pacote Agents 0.29.0 exige exatamente MCP SDK **2.3.1** em seus peer dependencies; usamos essa versão, em vez do 2.0.0 do exemplo antigo. Inspector **2.11.0** foi validado em substituição ao 2.10.1, que traz dependências vulneráveis (GHSA-jm63-cq47-j5jp e GHSA-6prh-2h8m-c8cw). O pool Workers antigo está descontinuado e seu runtime não suporta a data do projeto: usamos o sucessor oficial `@cloudflare/vitest-plugin` 1.4.6 com Vitest 4.1.12. `nodejs_compat` é necessário pelas dependências do Agents SDK. Todas as versões diretas são fixadas e `package-lock.json` é versionado.

## Agendor CRM

Contrato consultado em 2026-10-21: [OpenAPI V3 oficial](https://api.agendor.com.br/v3/swagger.json), publicado pela [documentação do Agendor](https://api.agendor.com.br/docs/). A API usa `https://api.agendor.com.br/v3`, autenticação `Authorization: Token <token>), GETs e quatro PUTs fixos com `crm:write`. Pessoas, organizações, negócios e tarefas preservam a paginação documentada. A API real exige data inferior para tarefas, então `updatedDateGt` é obrigatório e limitado aos últimos 31 dias.

As ferramentas de atualização permitem apenas campos explicitamente listados em [crm-write-api](docs/crm-write-api.md); não expõem criação, exclusão, status ganho/perdido, propriedade, associação nem campos personalizados. Não há alteração de registro real durante a validação.

## Agendor Chat

Quatro rotas GET documentadas foram confirmadas com a chave local: perfil, lista de conversas, detalhe e mensagens. O MCP oferece `chat_list_conversations`, `chat_get_conversation` e `chat_list_messages`, todas com `chat:read`. A origem e autenticação são fixas; `AGENDOR_CHAT_TOKEN` é independente da chave CRM. O verificador confirma a estrutura sem exibir dados e salva localmente o `account_id` do perfil em `.dev.vars`. Siga o contrato em [docs/agendor-chat-api.md](docs/agendor-chat-api.md). A API retornou 25 conversas e 20 mensagens na página padrão; continuação ainda não foi confirmada, portanto as ferramentas não seguem páginas automaticamente.

## Comandos

`npm test`, `npm run test:scripts`, `npm run test:watch`, `npm run typecheck`, `npm run build`, `npm run test:contract`, `npm run verify:chat-contract`, `npm run inspector`, `npm run verify:mcp`, `npm run deploy`.

Veja [operação e Inspector](docs/operations.md), [estado e procedimento de deploy](docs/deployment.md) e [evidências de implementação](docs/implementation-progress.md). No Windows, `npm run dev:ephemeral` contorna falhas do SQLite de persistência do runtime local.