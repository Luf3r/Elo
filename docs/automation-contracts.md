# Contratos de automação

Revisão documental em 2026-10-26: [OpenAPI CRM V3](https://api.agendor.com.br/v3/swagger.json) e [Postman Chat fornecido](https://documenter.getpostman.com/view/28016625/2sAXxV4UX5). A coleção pública foi consultada pela representação vinculada em sua página; não foram executadas chamadas autenticadas nesta implementação.

## Estados e limites de evidência

`ContractCapabilities` tem sete entradas: `chatMessageAfter`, `chatHistory`, `conversationDiscovery`, `contacts`, `attachments`, `customFields`, `collectionWriteSemantics`. Cada entrada contém `status`, `references` e `evidence` (apenas rótulos e tipos estruturais permitidos).

- `verified`: a leitura limitada respondeu com a estrutura esperada; não implica completude ou semântica adicional.
- `unverified`: documentação insuficiente, ausência de amostra, forma inesperada, timeout, HTTP de erro ou leitura indisponível. Um 404 não prova inexistência da capacidade.
- `unsupported`: somente negativa explícita da documentação ou evidência autorizada suficiente. O script atual não atribui esse estado por heurística.

| Capacidade | Evidência documental | Gate conservador |
|---|---|---|
| `chatMessageAfter` | GET de mensagens inclui `after` na coleção Postman | Mesmo com HTTP 200, ordenação, exclusividade, edição antiga e continuação continuam `unverified` |
| `chatHistory` | GET de mensagens | Página padrão observável; histórico completo `unverified` |
| `conversationDiscovery` | GET de conversas e de conversas por contato | Listagem dirigida possível; varredura completa `unverified` |
| `contacts` | GET `/accounts/{account}/contacts` | `verified` apenas para leitura com coleção `payload`, `data.payload` ou `data`; não confirma busca/paginação |
| `attachments` | GET `/accounts/{account}/conversations/{conversation}/attachments` | `verified` apenas para metadados em coleção; não baixa URLs/arquivos |
| `customFields` | GET `/custom_fields/{entity}` com `organizations`, `people`, `deals`, `products` | `verified` quando as quatro leituras têm `data` array; tipos/opções e escrita continuam dependentes de validação |
| `collectionWriteSemantics` | OpenAPI descreve os campos, mas não confirma integralmente merge/substituição/remoção | Sempre `unverified` nesta versão; nenhum teste de escrita |

Catálogo observado por GETs fixos: `/funnels`, `/deal_stages`, `/users`, `/products`, `/lead_origins`, `/categories`, `/sectors`. Formas de resposta entram como observações estruturais em `customFields.evidence`; não constituem prova de catálogo completo. Rotas e parâmetros foram conferidos na OpenAPI atual. O GET `after` usa somente um ID de mensagem obtido da mesma conversa, nunca um cursor inventado. Não percorre páginas, não segue links e não trata resposta vazia como prova de completude.

## Execução explícita

`npm run discover:automation-contracts -- --live`

Somente essa invocação exata habilita rede e leitura de `AGENDOR_CHAT_TOKEN` e `AGENDOR_CRM_TOKEN` do `.dev.vars` local ignorado. Tokens não são aceitos por argumentos. Importar o módulo ou executar testes não lê credenciais nem aciona rede. Não execute descoberta real sem autorização do operador.

`discoverAutomationContracts({request, emit})` recebe transporte `Request -> Promise<Response>` e emissor de linhas JSON. A função não usa `fetch` por padrão: o CLI injeta o transporte autenticado. IDs numéricos selecionados do perfil, conversas, contatos e mensagens permanecem apenas na memória e nas rotas necessárias. Nenhum parâmetro oferece URL/rota arbitrária. O relatório retornado é o mesmo JSON sanitizado enviado ao emissor.

Cada chamada é GET, com origem fixa Chat/CRM, redirects manuais recusados, timeout de até 10 segundos incluindo leitura do corpo, limite de 1 MiB por resposta e até 20 chamadas, sem retry. O CLI espaça leituras em 350 ms, usa tokens separados por origem e salva somente o relatório em `.tooling/automation-contracts.json` ignorado. Não grava IDs/configuração no `.dev.vars`.

As observações incluem somente tipos de estrutura e rótulos constantes. Chaves dinâmicas, exemplos, headers, URLs retornadas, IDs, nomes, mensagens, valores de campos e erros crus nunca são serializados. Fixtures e testes são integralmente sintéticos. O relatório não autoriza escrita nem interpretação pelo backend: a interpretação permanece no agente MCP, sem API de LLM.

## Cobertura disponível para as próximas tarefas

Leituras dirigidas podem implementar as rotas documentadas e declarar cobertura parcial. Varredura geral e histórico integral continuam bloqueados até evidência adicional comprovar continuação e limites. Após futura evidência autorizada, registrar referência e casos sintéticos específicos antes de promover um gate de semântica. Não promover `after` apenas porque o servidor aceitou o parâmetro.
