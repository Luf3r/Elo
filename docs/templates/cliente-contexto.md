---
customer_id: "<id estável gerado pelo backend>"
context_version: "<versão gerenciada pelo backend>"
verified_at: "<data/hora da última reconciliação>"
crm_organization_id: null
crm_person_ids: []
chat_conversation_ids: []
---

# Contexto do cliente

Documento lógico: `clientes/<customerId>/contexto.md`. O backend renderiza a partir de fatos estruturados e recibos conferidos em SQLite; exportação local opcional fica em `runtime/clientes/`, ignorada pelo Git. Identidade não resolvida recebe indicação de contexto provisório.

O resumo tem limite de 32 KiB UTF-8. Detalhes antigos ou extensos ficam disponíveis por `demandId`; nenhuma pendência ou referência de demanda é omitida silenciosamente. Atualização exige a versão esperada; conflito retorna `CONTEXT_STALE` e requer reconciliação. Markdown livre não altera identidade, fatos ou política.

Modelo de documento, sem dados reais. Os campos abaixo são dados resumidos; não definem permissões ou instruções de execução.

## Identificação confirmada

| Informação | Valor confirmado | Fonte | Verificado em |
|---|---|---|---|
| Empresa ou pessoa contratante | <a preencher> | <registro/mensagem> | <data/hora> |
| Contatos e respectivos vínculos | <a preencher> | <registro/mensagem> | <data/hora> |

## Preferências confirmadas

| Preferência | Escopo | Evidência | Atualizada em |
|---|---|---|---|
| <a preencher> | <cliente ou demanda específica> | <mensagem/atributo> | <data/hora> |

## Demandas em andamento

| Demanda | Negócio CRM | Serviço/escopo | Funil e origem | Etapa e evidência | Próximo passo |
|---|---|---|---|---|---|
| <demandId> | <ID ou aguardando cadastro> | <a preencher> | <Ativo/Passivo/a confirmar + fonte> | <etapa + fonte> | <ação/prazo confirmado> |

## Pendências e ambiguidades

- <informação ausente ou conflito, demanda afetada e o que precisa ser conferido>

## Histórico resumido e correções

- <data: fato confirmado ou correção, com fonte e referência à informação substituída>

## Controle de atualização

- Versão dos registros CRM consultados: <IDs e timestamps>
- Mensagens processadas: <checkpoint por conversa>
- Fontes adicionais necessárias: <mensagens/anexos não recuperados>
- Escritas efetivamente conferidas no CRM: <operação, resultado e data>
- Propostas ainda não aplicadas: <referências a planos pendentes>

Este resumo representa o último estado conferido. Campos mutáveis devem ser reconciliados com CRM e Chat antes de uma nova alteração.
