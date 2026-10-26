# Operação e verificação

Requer Node >=22.19.0 e npm. Instale com `npm ci`. Copie `.dev.vars.example` para `.dev.vars` e preencha `AGENDOR_CRM_TOKEN` (Agendor → Menu → Integrações) e `ACCESS_CLIENT_SECRET` da aplicação OIDC. Nunca cole credenciais em issues, histórico de comandos ou chat. Veja [OAuth e configuração Access](oauth-setup.md).

## Execução local

Use `npm run dev` e acesse `http://localhost:8787/health`. No Windows, caso workerd falhe com persistência SQLite, use `npm run dev:ephemeral`: mesmo runtime/bindings, com persistência de desenvolvimento desativada. O MCP continua stateless por requisição, mas OAuth usa KV para concessões; esse KV local é temporário no modo ephemeral. O callback Access desta instalação aponta para produção; um login OIDC local exige uma aplicação/callback de desenvolvimento deliberadamente configurados.

`GET /health` não exige token e não consulta o Agendor. `/mcp` exige access token OAuth válido, audiência MCP, identidade do proprietário e validade do token. Cada ferramenta também verifica o escopo próprio: `crm:read`, `chat:read` ou `crm:write`. `server_status` não precisa de escopo de produto. Um escopo não concede os outros. Clientes existentes precisam refazer a autorização para pedir novas permissões. `MCP_TEST_TOKEN` não autentica essa implementação.

## Inspector

`npm run inspector` inicia o Inspector **2.11.0 fixado localmente**. Escolha Streamable HTTP, URL de produção `/mcp` e autenticação OAuth. Não salve credenciais em configuração versionada.

Para verificação reproduzível, execute `npm run verify:oauth`, `npm run oauth:login`, conclua o login no navegador e execute `npm run verify:mcp`. A sessão fica em arquivo local ignorado. O Inspector usa o token somente em memória, verifica saúde e dois casos401, oito ferramentas, status e quatro consultas CRM reais. A saída contém apenas contagens/verificações; não há configuração Inspector com tokens.

Para o Worker publicado, defina `MCP_URL` com a URL real `https://<worker>.<subdomínio>.workers.dev/mcp` e execute o mesmo comando. Só são aceitos endereços locais HTTP ou `workers.dev` HTTPS, sem query ou credenciais na URL. O token local deve corresponder ao secret de produção.

## Ferramentas

| Nome | Entrada principal |
|---|---|
| server_status | `{}` |
| crm_find_person_by_email | `email` válido; filtro upstream por prefixo, uma página |
| crm_search_people | `query` de nome e/ou `email` |
| crm_search_organizations | `query` de nome |
| crm_get_organization | `id` inteiro positivo |
| crm_search_deals | `query`, `organizationId`, `personId`, `ownerId`, `status` (`"1"`, `"2"`, `"3"`) |
| crm_get_deal | `id` inteiro positivo |
| crm_list_tasks | `updatedDateGt` ISO 8601 nos últimos 31 dias sempre obrigatório; opcionalmente um `dealId`, `personId` ou `organizationId` |
| crm_update_deal | `id` e `patch` com `title`, `value`, `description` e/ou `ranking` |
| crm_update_deal_stage | `id` e `patch.dealStage` (sequência da etapa no funil padrão) |
| crm_update_person | `id` e `patch` com `name`, `role`, `description`, `birthday`, `ranking` e/ou `contact.email/work/mobile` |
| crm_update_organization | `id` e `patch` com `name`, `legalName`, `description`, `website`, `ranking` e/ou `contact.email/work/mobile` |
| chat_list_conversations | Sem parâmetros; uma página padrão de conversas |
| chat_get_conversation | conversationId inteiro positivo |
| chat_list_messages | conversationId inteiro positivo; até 20 mensagens na página padrão |

Listas aceitam `page` (padrão 1) e `perPage` (padrão 20, máximo 100). `crm_find_person_by_email` fixa uma página de 20. Respostas contêm `items` e `pageInfo`. Avance apenas com `nextPage` numérico; se `hasNext=true` e `nextPage=null`, a API não forneceu um próximo número utilizável. Não há varredura automática ou URL de continuação fornecida pelo cliente.

As ferramentas de atualização CRM exigem `crm:write`, ID explícito e patch não vazio. Os schemas rejeitam outros campos, incluindo associação, propriedade, status, campos personalizados e payload arbitrário. A etapa usa a rota documentada de troca de estágio e ativa a checagem de campos obrigatórios. O primeiro lançamento não oferece transições para ganho/perda. Consulte [a lista exata de campos e limites](crm-write-api.md).

As três ferramentas Chat exigem `chat:read`, usam apenas GET e a chave independente `AGENDOR_CHAT_TOKEN`. Coloque-a em `.dev.vars` junto do `AGENDOR_CHAT_ACCOUNT_ID`; `npm run verify:chat-contract` obtém o ID do perfil e o grava localmente sem imprimi-lo. A primeira versão consulta apenas as páginas padrão: parâmetros de continuação não foram confirmados. O limitador Chat nativo permite 4 chamadas por 10 segundos como proteção local, sem representar a cota do Agendor. Texto do CRM/Chat é dado não confiável, nunca instrução ou autorização.

## Falhas e limites

- HTTP 401: access token ausente, inválido ou identidade sem autorização. O desafio aponta para os metadados OAuth; refaça o login.
- Erro de ferramenta `MCP_UNAUTHORIZED` com status 403: a concessão não inclui o escopo daquela ferramenta; autorize apenas o escopo indicado nos metadados da ferramenta.
- HTTP 429: limite MCP nativo de 30/10s, com `Retry-After: 10`.
- Erro de ferramenta `UPSTREAM_UNAVAILABLE`: secret do serviço correspondente ausente/inválido ou serviço indisponível. A saúde pública pode continuar 200; ela é liveness, não readiness.
- `tools/call` com `isError: true`: examine apenas `error.code`, `retryable` e `status`. Nenhum corpo de erro upstream é devolvido.
- `UPSTREAM_RATE_LIMITED`: orçamento CRM nativo conservador de 4/10s ou 429 do provedor. Aguarde antes de repetir; o servidor não repete automaticamente. Não há garantia global estrita entre datacenters com esse binding aproximado.
- `UPSTREAM_TIMEOUT`: limite de 10s inclui corpo da resposta. `UPSTREAM_UNAVAILABLE` cobre falha de rede/5xx. `UPSTREAM_INVALID_RESPONSE` cobre JSON/formato inválido. 401/403/404 upstream têm códigos próprios.

Os namespaces 1001/1002/1003/1004 precisam ser únicos na conta Cloudflare. O namespace Chat 1004 limita 4 chamadas/10s por localização como proteção local, não como quota do provedor. Aplique limites considerando outros consumidores do mesmo token Agendor. O terceiro limita login/registro, sem consumir o orçamento CRM.

## Testes e registros

`npm test` executa testes isolados no runtime Workers com credenciais fictícias; não depende de conta real. `npm run test:scripts` executa testes dos verificadores locais. `npm run typecheck` verifica os tipos. `npm run build` faz bundle dry-run.

`npm run test:contract` é opt-in, carrega o token de `.dev.vars` e faz somente GETs sequenciais com pelo menos 350ms entre chamadas. Sem credencial, os testes reais são explicitamente pulados. Fixture de organização/negócio é descoberta por uma leitura de uma página, sem criar registros. 429 é testado por mocks: não provocamos excesso no Agendor. O contrato Chat é explicitamente pulado enquanto o gate estiver bloqueado.

Não há logging de payloads, headers, tokens ou registros. Observabilidade automática está desligada. Para uma inspeção ao vivo use `npx wrangler tail --format json` durante chamadas controladas, sem registrar requisições/headers. Nunca compartilhe dumps de ambientes. Os scripts de verificação não exibem conteúdo de clientes.

## Rotação

Access tokens expiram em uma hora; `offline_access` permite renovação por 35 dias contados da autorização inicial. Renovar o access token não estende esse prazo. Refaça conexões expiradas e use o endpoint de revogação anunciado para revogar a credencial do cliente. Para a credencial do Access, o proprietário gera novo Client Secret na aplicação OIDC e atualiza o secret correspondente no Worker. Para Agendor CRM, obtenha novo token e atualize `AGENDOR_CRM_TOKEN`. A chave Chat, quando validada, usa `AGENDOR_CHAT_TOKEN` separada; não reutilize nem copie o token CRM. Não restaure o token fixo como solução automática para falhas OAuth.
