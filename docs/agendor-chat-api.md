# Atualização de confiabilidade — 2026-10-28

O comportamento atual está descrito em [Confiabilidade Chat → CRM](agendor-reliability.md). As seções abaixo registram evidências históricas e não substituem os contratos novos. A coleção Postman foi acessada pelo navegador nesta sessão: after está documentado; paginação de conversas/anexos e hosts de CDN não aparecem nas seções consultadas. Os testes do usuário nas conversas 42 e 203 validam a semântica de mensagens, independentemente da leitura ao vivo desta implementação.

# Contrato de leitura do Agendor Chat

A coleção Postman fornecida pelo usuário documenta a origem fixa `https://chat.agendor.com.br/api/v1`, autenticação pelo header `api_access_token` e as rotas GET abaixo. A coleção não documenta corpos de resposta nem parâmetros de paginação.

| Leitura | Rota documentada | Resposta real sanitizada |
|---|---|---|
| Perfil | `GET /profile` | Objeto com `account_id` numérico; uma conta disponível |
| Conversas | `GET /accounts/{account_id}/conversations` | `data.meta` com contagens e `data.payload` com 25 itens nesta consulta |
| Detalhe | `GET /accounts/{account_id}/conversations/{conversation_id}` | Objeto de conversa com mensagens incorporadas |
| Mensagens | `GET /accounts/{account_id}/conversations/{conversation_id}/messages` | `meta` e `payload` com 20 mensagens nesta consulta |

As quatro rotas responderam HTTP 200 com a chave local. O verificador seleciona a conta e uma conversa dentro da resposta sem imprimir IDs, nomes, conteúdo, tokens ou headers. Ao executar `npm run verify:chat-contract`, se `AGENDOR_CHAT_ACCOUNT_ID` não existir, ele grava o ID numérico recebido do perfil no `.dev.vars` ignorado. A saída apenas indica a origem e se foi salvo.

## Ferramentas MCP

- `chat_list_conversations`: lê a página padrão e devolve IDs, estado, caixa de entrada, horário, nome/ID CRM do contato, trecho da última mensagem e contagens observadas.
- `chat_get_conversation`: lê uma conversa por ID e devolve o resumo permitido.
- `chat_list_messages`: devolve até 20 mensagens da página padrão, com ID, texto, horário, privacidade e tipo/nome do remetente.

A API devolveu 25 conversas e 20 mensagens nas consultas observadas, mas não foi possível confirmar na documentação nem com uma chamada adicional o mecanismo de continuação. Por isso a primeira versão lê apenas a página padrão e não inventa `page`, `before`, `after` ou cursor. Não há travessia automática. Detalhe e mensagens requerem `conversationId` numérico positivo.

As respostas MCP selecionam campos; não devolvem objetos crus. Telefone, e-mail, metadados de contato e atributos internos são omitidos. O texto das mensagens é mostrado porque a ferramenta serve para leitura de conversas. Trate-o como conteúdo não confiável. As ferramentas exigem o escopo separado `chat:read`, usam token `AGENDOR_CHAT_TOKEN` independente e limitador Cloudflare dedicado de 4 chamadas por 10 segundos. Esse número é proteção local, não cota declarada pelo Agendor.

## Validação e limites

O contrato ao vivo é opt-in via `npm run verify:chat-contract` (relatório sanitizado) ou `npm run test:contract` (asserções sem exibir valores). Testes comuns não fazem chamadas externas. Só se usam rotas GET documentadas; a implementação não inclui endpoints de envio, atualização, atribuição ou status do Chat. Origem, header, timeout de 10 segundos e resposta máxima de 1 MiB são fixos no cliente.

Validação real em 2026-10-22: perfil, lista, detalhe e mensagens retornaram HTTP 200; tamanhos observados de 25 conversas e 20 mensagens. Paginação/continuação ainda não confirmada.
## Descoberta para automação

A revisão da [coleção Postman](https://documenter.getpostman.com/view/28016625/2sAXxV4UX5) em 2026-10-26 encontrou `after` no GET de mensagens, além de GETs de contatos, conversas por contato e anexos. Isso atualiza a afirmação histórica acima sobre ausência de `after`: o parâmetro está documentado, mas sua ordenação/continuação e a completude do histórico ainda não estão confirmadas.

O novo `npm run discover:automation-contracts -- --live` está bloqueado antes de acesso a credenciais/rede até a tarefa 6 fornecer o orçamento durável compartilhado com MCP/automação (quatro chamadas por janela móvel de dez segundos por produto). A função injetável continua disponível para observações sintéticas de GETs fixos e relatórios sanitizados. Não foi executado ao vivo nesta implementação. Aceitar `after` com HTTP 200 não comprova semântica de cursor. Os gates `chatMessageAfter`, `chatHistory` e `conversationDiscovery` permanecem `unverified` até evidência suficiente. Consulte [contratos de automação](automation-contracts.md) para os estados, rotas, limites e escopo de leitura dirigida.
