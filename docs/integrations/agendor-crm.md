# Integração Agendor CRM V3

Contrato vigente e limites do adaptador `src/agendor/crm/`.

## Autenticação, transporte e orçamento

- **Origem fixa**: `https://api.agendor.com.br/v3` (autenticação por token `AGENDOR_CRM_TOKEN`, sem URLs ou contas arbitrárias).
- **Orçamento**: toda chamada real (leitura, busca, catálogo, mutação e `GET` de confirmação pós-escrita) reserva previamente crédito no gate compartilhado do DO `AutomationAccount` (`4` requisições por janela móvel de `10.000 ms`).
- **Timeouts e redirects**: timeout de até `10 s` incluindo leitura do corpo; redirects não são seguidos; erros upstream são sanitizados via `SafeError`.

## Leituras e buscas

- **Identificadores**: consultas individuais (`crm_get_person`, `crm_get_organization`, `crm_get_deal`, `crm_get_task`) exigem ID inteiro positivo `int32`.
- **Paginação**: `page` e `perPage` (máximo `100`). Só avance paginação com continuação explícita.
- **Buscas por prefixo**: filtros como nome, e-mail, CPF e CNPJ na API CRM operam por prefixo em vários endpoints; sempre compare os campos retornados localmente por igualdade normalizada antes de assumir vínculo de identidade.
- **Tarefas (`crm_list_tasks`)**: toda consulta de tarefas (genérica ou filtrada por empresa/pessoa/negócio) exige `updatedDateGt` em formato ISO 8601 dentro dos últimos **31 dias**, conforme comportamento observado na API real.
- **Catálogo (`crm_get_configuration`)**: consulta seções fixas (`/funnels`, `/deal_stages`, `/users`, `/products`, `/lead_origins`, `/categories`, `/sectors`, `/custom_fields/{entity}`, cidades por UF). `stages` exige `funnelId`; `customFields` exige `entityType` (`organizations`, `people`, `deals`, `products`); somente `products` possui paginação documentada. Nunca infira unicidade a partir de catálogo parcial.

## Escrita, criação e enriquecimento

- **Separação de escopos**:
  - `crm:write`: preserva apenas os 4 `PUT` legados (`crm_update_deal`, `crm_update_deal_stage`, `crm_update_person`, `crm_update_organization`) com payload parcial e retorno `{ id, updatedFields }`.
  - `crm:create`: `crm_create_organization`, `crm_create_person`, `crm_create_deal`, `crm_create_task`. Exigem `requestId`.
  - `crm:enrich`: `crm_enrich_organization`, `crm_enrich_person`, `crm_enrich_deal`, `crm_update_task`. Exigem `requestId`.
- **Conferência pós-escrita e limites conhecidos**:
  - Todas as mutações passam pelo executor reservado e realizam leitura `GET` de confirmação antes de emitir recibo `confirmed`.
  - A API do Agendor CRM não oferece compare-and-swap (CAS) condicional; edições humanas ou externas entre o `GET` de verificação e o `POST`/`PUT` são mitigadas por rechecagem antes/depois, mas não são elimináveis no upstream.
  - Permanecem bloqueados por semântica de coleção não comprovada: escrita de `products_entities` (inclusive preços) e substituição em `PUT` de `customFields` e `assigned_users`.
  - `dealStage` em mudança de etapa representa a **sequência** da etapa, e `funnel` informa o ID inteiro do funil quando diferente do padrão.
  - Status ganho/perdido não é exposto; exclusões e rotas arbitrárias não existem.
