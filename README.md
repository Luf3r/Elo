# Elo Agendor Remote MCP

Worker TypeScript de consulta ao Agendor CRM, com Streamable HTTP em `/mcp` e `GET /health` público.

Requer Node >=22.19.0. Execute `npm ci`, copie `.dev.vars.example` para `.dev.vars`, preencha os dois segredos localmente e execute `npm run dev`. Nunca envie tokens no chat nem use `vars` do Wrangler para credenciais.

## Dependências verificadas

Em 2026-10-21, a [documentação oficial](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/) recomenda `createMcpHandler` com uma factory que cria um novo servidor por requisição. O pacote Agents 0.29.0 exige exatamente MCP SDK **2.3.1** em seus peer dependencies; usamos essa versão, em vez do 2.0.0 do exemplo antigo. Inspector **2.11.0** foi validado em substituição ao 2.10.1, que traz dependências vulneráveis (GHSA-jm63-cq47-j5jp e GHSA-6prh-2h8m-c8cw). O pool Workers antigo está descontinuado e seu runtime não suporta a data do projeto: usamos o sucessor oficial `@cloudflare/vitest-plugin` 1.4.6 com Vitest 4.1.12. `nodejs_compat` é necessário pelas dependências do Agents SDK. Todas as versões diretas são fixadas e `package-lock.json` é versionado.

## Agendor CRM contract notes

Contrato consultado em 2026-10-21: [OpenAPI V3 oficial](https://api.agendor.com.br/v3/swagger.json), publicado pela [documentação do Agendor](https://api.agendor.com.br/docs/).

- Base: `https://api.agendor.com.br/v3`; autenticação `Authorization: Token <token>`; somente GET.
- Pessoas e empresas: `query` mapeia para `name` (prefixo); email também é filtro por prefixo. `crm_find_person_by_email` retorna os resultados dessa única página, sem prometer igualdade exata ou percorrer todo o banco.
- Negócios: `query` → `title` (prefixo), `organizationId` → `organization`, `personId` → `person`, `ownerId` → `userOwner`, `status` → `dealStatus` (`"1"`, `"2"`, `"3"`, IDs do contrato).
- Tarefas: a API real exige um limite inferior de data para GET `/tasks` e para as rotas por entidade, apesar de o OpenAPI marcar essas datas como opcionais. O MCP sempre exige `updatedDateGt` ISO 8601 nos últimos 31 dias (sem data implícita). Para pessoa, empresa ou negócio, utiliza os GETs documentados `/people/{id}/tasks`, `/organizations/{id}/tasks` e `/deals/{id}/tasks`. Aceita no máximo um ID. Essa divergência foi reproduzida em GETs reais e testes de regressão.
- Listas: `page` e `per_page` (1–100), padrão MCP 1/20. `links.next` é convertido apenas em metadados numéricos, nunca seguido nem exposto como URL navegável.
- [Limite oficial: 4 requisições/segundo](https://ajuda.agendor.com.br/pt-BR/articles/2660512-o-agendor-pode-ser-integrado-ao-meu-sistema-atual). Além do limite MCP de 30/10s, há um segundo binding nativo conservador de **4 consultas CRM/10s**, aplicado por chamada de ferramenta. Não há retries automáticos. Isso impede rajadas intencionais do cliente acima da cota. O [limite nativo](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) é aproximado e por localização, não uma garantia global de 4/s entre datacenters; garantia global exigiria coordenação fora do escopo deste plano.
- Namespaces `1001` (MCP) e `1002` (CRM) precisam ser únicos na conta; altere-os se já estiverem intencionalmente em uso.

## Agendor Chat: blocked pending technical API contract

Chat desativado. Nenhuma rota ou autenticação foi inferida. O token Chat não é requisito de deploy. Consulte [o gate](docs/agendor-chat-api.md).

## Comandos

`npm test`, `npm run test:watch`, `npm run typecheck`, `npm run build`, `npm run test:contract`, `npm run inspector`, `npm run verify:mcp`, `npm run deploy`.

Veja [operação e Inspector](docs/operations.md), [estado e procedimento de deploy](docs/deployment.md) e [evidências de implementação](docs/implementation-progress.md). No Windows, `npm run dev:ephemeral` contorna falhas do SQLite de persistência do runtime local.
