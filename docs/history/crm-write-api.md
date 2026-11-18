# Atualizações permitidas no Agendor CRM

As ferramentas novas alteram apenas registros existentes por ID. A API oficial documenta `PUT /v3/deals/{id}`, `PUT /v3/deals/{id}/stage`, `PUT /v3/people/{id}` e `PUT /v3/organizations/{id}` no [OpenAPI V3](https://api.agendor.com.br/v3/swagger.json). O escopo `crm:write` é obrigatório e independente de `crm:read`.

| Ferramenta | Campos permitidos |
|---|---|
| `crm_update_deal` | `title` (até 150 caracteres), `value` (número de 0 a 1.000.000.000.000), `description` (até 2.000 caracteres), `ranking` (0–5) |
| `crm_update_deal_stage` | `dealStage` (sequência inteira positiva) e `funnel` (ID inteiro opcional para funis não padrão). A operação usa `/deals/{id}/stage` e pede ao Agendor para verificar campos obrigatórios. Status ganho/perdido não é exposto. |
| `crm_update_person` | `name` (até 150 caracteres), `role` (até 150), `description` (até 700), `birthday` (`YYYY-MM-DD` ou `MM-DD`), `ranking` (0–5), `contact.email`, `contact.work`, `contact.mobile` |
| `crm_update_organization` | `name` (até 150), `legalName` (até 255), `description` (até 700), `website` (URL), `ranking` (0–5), `contact.email`, `contact.work`, `contact.mobile` |

Cada operação exige ID numérico inteiro positivo no limite `int32` da API e um patch não vazio. Objetos são estritos; campos não listados e chaves extras são rejeitados. A [documentação oficial de exemplos](https://ajuda.agendor.com.br/pt-BR/articles/2653028-voces-tem-exemplos-de-como-utilizar-a-api-do-agendor) mostra um `PUT` que envia somente um campo (`allowedUsers`) para um negócio existente, confirmando o uso de payload parcial. O cliente retorna somente o ID e os nomes dos campos enviados, sem copiar o conteúdo do registro retornado. Os testes simulam as respostas HTTP e não alteram dados reais.

O OpenAPI também descreve campos de propriedade, associação, customização, status, datas de encerramento e permissões de visibilidade. Esses campos ficam fora desta primeira versão. `dealStage` no caminho `/stage` é a sequência da etapa. O campo opcional `funnel` recebe o ID inteiro do funil de destino; a API exige esse valor quando a etapa alvo pertence a um funil diferente do padrão. O MCP não consulta etapas nem verifica previamente se a etapa pertence ao funil; a API valida essa combinação.
