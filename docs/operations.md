# Operação e verificação

Requer Node >=22.19.0 e npm. Instale com `npm ci`. Copie `.dev.vars.example` para `.dev.vars` e preencha `AGENDOR_CRM_TOKEN` (Agendor → Menu → Integrações). Gere `MCP_TEST_TOKEN` com `npm run setup:token`, que grava 32 bytes aleatórios em hexadecimal somente no arquivo ignorado. O comando não mostra o token. Nunca cole credenciais em issues, histórico de comandos ou chat.

## Execução local

Use `npm run dev` e acesse `http://localhost:8787/health`. No Windows, caso workerd falhe com `SQLITE_CANTOPEN` ou criação de `miniflare-CacheObject`, use `npm run dev:ephemeral`: mesmo Wrangler/runtime, bindings nativos e segredos, com persistência local desativada. O Worker é stateless e não precisa dessa persistência.

`GET /health` não exige token e não consulta o Agendor. `/mcp` exige `Authorization: Bearer <MCP_TEST_TOKEN>` em toda requisição. Nenhum cliente externo foi conectado.

## Inspector

`npm run inspector` inicia o Inspector **2.11.0 fixado localmente**. Escolha Streamable HTTP, URL `http://localhost:8787/mcp`, e configure o cabeçalho Bearer com o valor de `.dev.vars`. Não salve esse segredo em configuração versionada.

Para verificação reproduzível sem imprimir dados de clientes ou tokens: com o Worker rodando, execute `npm run verify:mcp`. O script usa a CLI do Inspector em memória, lê a credencial de `.dev.vars`, verifica saúde e os dois casos 401, lista oito ferramentas, chama `server_status` e faz quatro consultas CRM reais. A saída contém apenas resultados de verificações. Não crie arquivos de configuração Inspector com tokens.

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
| crm_list_tasks | um `dealId`, `personId` ou `organizationId`; sem ID exige `updatedDateGt` ISO 8601 nos últimos 31 dias |

Listas aceitam `page` (padrão 1) e `perPage` (padrão 20, máximo 100). `crm_find_person_by_email` fixa uma página de 20. Respostas contêm `items` e `pageInfo`. Avance apenas com `nextPage` numérico; se `hasNext=true` e `nextPage=null`, a API não forneceu um próximo número utilizável. Não há varredura automática ou URL de continuação fornecida pelo cliente.

O Chat permanece **BLOCKED**, mesmo que uma variável de token Chat exista. Texto do CRM é dado não confiável; o servidor apenas o serializa, sem executar instruções, fazer novas chamadas ou alterar permissões.

## Falhas e limites

- HTTP 401: Bearer ausente/incorreto ou MCP secret inválido; resposta igual para tokens errados de tamanhos diferentes.
- HTTP 429: limite MCP nativo de 30/10s, com `Retry-After: 10`.
- HTTP 503: CRM secret ausente/inválido ou binding indisponível. A saúde pública pode continuar 200; ela é liveness, não readiness.
- `tools/call` com `isError: true`: examine apenas `error.code`, `retryable` e `status`. Nenhum corpo de erro upstream é devolvido.
- `UPSTREAM_RATE_LIMITED`: orçamento CRM nativo conservador de 4/10s ou 429 do provedor. Aguarde antes de repetir; o servidor não repete automaticamente. Não há garantia global estrita entre datacenters com esse binding aproximado.
- `UPSTREAM_TIMEOUT`: limite de 10s inclui corpo da resposta. `UPSTREAM_UNAVAILABLE` cobre falha de rede/5xx. `UPSTREAM_INVALID_RESPONSE` cobre JSON/formato inválido. 401/403/404 upstream têm códigos próprios.

Os namespaces 1001/1002 precisam ser únicos na conta Cloudflare. Aplique limites considerando outros consumidores do mesmo token Agendor.

## Testes e registros

`npm test` executa testes isolados no runtime Workers com credenciais fictícias; não depende de conta real. `npm run typecheck` verifica os tipos. `npm run build` faz bundle dry-run.

`npm run test:contract` é opt-in, carrega o token de `.dev.vars` e faz somente GETs sequenciais com pelo menos 350ms entre chamadas. Sem credencial, os testes reais são explicitamente pulados. Fixture de organização/negócio é descoberta por uma leitura de uma página, sem criar registros. 429 é testado por mocks: não provocamos excesso no Agendor. O contrato Chat é explicitamente pulado enquanto o gate estiver bloqueado.

Não há logging de payloads, headers, tokens ou registros. Observabilidade automática está desligada. Para uma inspeção ao vivo use `npx wrangler tail --format json` durante chamadas controladas, sem registrar requisições/headers. Nunca compartilhe dumps de ambientes. Os scripts de verificação não exibem conteúdo de clientes.

## Rotação

Gere novo MCP token localmente, atualize o secret de produção com `npx wrangler secret put MCP_TEST_TOKEN` por entrada interativa e atualize o cliente autorizado. Valide o novo token e confirme que o anterior retorna 401. Substitua o token Agendor pelo mesmo processo com `AGENDOR_CRM_TOKEN`, sem editar código. Não reutilize esse token de teste como credencial permanente compartilhada de clientes reais.
