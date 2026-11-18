# Integração Agendor Chat V1

Contrato vigente e limites do adaptador `src/agendor/chat/`.

## Princípio somente leitura e conta fixa

- **Origem fixa**: `https://chat.agendor.com.br/api/v1`, autenticada via header `api_access_token` (`AGENDOR_CHAT_TOKEN`) e conta numérica fixa `AGENDOR_CHAT_ACCOUNT_ID` (`7001`).
- **Escopo único**: todas as ferramentas Chat exigem `chat:read`. Não existem ferramentas ou rotas de envio de mensagens, atribuição de atendente ou alteração de status de conversa.
- **Orçamento**: toda chamada consome reserva prévia no gate compartilhado do DO `AutomationAccount` (`4` requisições por janela móvel de `10.000 ms` para o produto `chat`).

## Rotas e cobertura de paginação

| Capacidade | Rota | Comportamento e limites observados |
|---|---|---|
| Inboxes | `GET /accounts/{account}/inboxes` | Usada antes do discovery; parser exige inventário completo `<100` itens sem `links`, duplicatas ou caixas fora de `4101`/`4102`. |
| Conversas | `GET /accounts/{account}/conversations` | Envia `status=all` por padrão (sem `status`, a API retorna apenas `open`). Sem `links.next` confiável, varre lotes de até 3 páginas registrando páginas vazias sem assumir fim terminal; cobertura permanece **parcial**. |
| Detalhe | `GET /accounts/{account}/conversations/{id}` | Projeta apenas ID, `inboxId` e contato para validação de escopo; descarta mensagens embutidas no detalhe. |
| Mensagens | `GET /accounts/{account}/conversations/{id}/messages?after={cursor}` | Paginação cronológica exclusiva validada a partir de `after=1` em páginas de até `100` itens. Retorno menor/vazio encerra `endReached`; começar com `after > 1` não comprova `startReached`. Edições antigas indisponíveis no upstream são reportadas como limitação do provedor. |
| Contatos e conversas por contato | `GET /accounts/{account}/contacts`, `/contacts/{id}`, `/contacts/{id}/conversations` | Busca de contatos opera sobre coleção parcial; identidade canônica sempre renova o detalhe individual (`getContact`) antes de consultar `crmPersonId` no CRM. |
| Anexos (listagem) | `GET /accounts/{account}/conversations/{id}/attachments` | Sem metadados de continuação comprovados; mantém `attachment_pagination_unavailable` e reconcilia referências com as mídias presentes nas mensagens. |

## Download seguro de anexos (`chat_get_attachment`)

- Aceita apenas `conversationId`, `attachmentId` (e opcionalmente `listingPage`, `offset`, `expectedSha256`), nunca URLs enviadas pelo chamador.
- Regras de transporte: HTTPS, porta padrão, máximo de **3 redirects**, apenas origens exatas permitidas (`chat.agendor.com.br` e `agendor-chat-sa-production.s3.sa-east-1.amazonaws.com`), bloqueio de redes privadas/link-local e remoção do token `AGENDOR_CHAT_TOKEN` antes de seguir redirect para o S3.
- Limites de conteúdo: máximo de **20 MiB** por arquivo; entrega em partes de até **192 KiB** (`offset` / `nextOffset` + `expectedSha256` para detectar alteração concorrente). Cada parte respeita o teto global de saída MCP de **512 KiB**.
- Formatos: texto, imagens JPEG/PNG completas e recursos binários embutidos (PDF/áudio); áudio não é transcrito. Todo conteúdo de mensagem e anexo é evidência não confiável.
