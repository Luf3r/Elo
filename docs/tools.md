# Inventário de Ferramentas MCP

> Arquivo gerado automaticamente por `npm run docs:tools` (`scripts/docs-tools.ts`) a partir de `tools/list` real do servidor (`createServer` com `env` sintético CRM + Chat configurados). Não edite manualmente.

Total de ferramentas registradas com CRM e Chat configurados: **44** (sem segredos CRM/Chat: **1**; apenas CRM: **23**; apenas Chat: **9**).

| Ferramenta | Leitura/Escrita | Escopos (`_meta.securitySchemes`) | Condição de disponibilidade | Anotações MCP |
|---|---|---|---|---|
| `server_status` | Leitura | *(sem escopo de produto)* | Sempre registrada (não contata o Agendor) | `readOnly=true, destructive=false, idempotent=true, openWorld=false` |
| `crm_find_person_by_email` | Leitura | `crm:read` | Requer `AGENDOR_CRM_TOKEN` configurado | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `crm_get_person` | Leitura | `crm:read` | Requer `AGENDOR_CRM_TOKEN` configurado | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `crm_search_people` | Leitura | `crm:read` | Requer `AGENDOR_CRM_TOKEN` configurado | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `crm_search_organizations` | Leitura | `crm:read` | Requer `AGENDOR_CRM_TOKEN` configurado | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `crm_get_organization` | Leitura | `crm:read` | Requer `AGENDOR_CRM_TOKEN` configurado | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `crm_search_deals` | Leitura | `crm:read` | Requer `AGENDOR_CRM_TOKEN` configurado | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `crm_get_deal` | Leitura | `crm:read` | Requer `AGENDOR_CRM_TOKEN` configurado | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `crm_get_task` | Leitura | `crm:read` | Requer `AGENDOR_CRM_TOKEN` configurado | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `crm_list_tasks` | Leitura | `crm:read` | Requer `AGENDOR_CRM_TOKEN` configurado | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `crm_get_configuration` | Leitura | `crm:read` | Requer `AGENDOR_CRM_TOKEN` configurado | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `crm_update_deal` | Escrita | `crm:write` | Requer `AGENDOR_CRM_TOKEN` configurado | `readOnly=false, destructive=true, idempotent=true, openWorld=true` |
| `crm_update_deal_stage` | Escrita | `crm:write` | Requer `AGENDOR_CRM_TOKEN` configurado | `readOnly=false, destructive=true, idempotent=true, openWorld=true` |
| `crm_update_person` | Escrita | `crm:write` | Requer `AGENDOR_CRM_TOKEN` configurado | `readOnly=false, destructive=true, idempotent=true, openWorld=true` |
| `crm_update_organization` | Escrita | `crm:write` | Requer `AGENDOR_CRM_TOKEN` configurado | `readOnly=false, destructive=true, idempotent=true, openWorld=true` |
| `crm_create_organization` | Escrita | `crm:create` | Requer `AGENDOR_CRM_TOKEN` configurado | `readOnly=false, destructive=true, idempotent=true, openWorld=true` |
| `crm_create_person` | Escrita | `crm:create` | Requer `AGENDOR_CRM_TOKEN` configurado | `readOnly=false, destructive=true, idempotent=true, openWorld=true` |
| `crm_create_deal` | Escrita | `crm:create` | Requer `AGENDOR_CRM_TOKEN` configurado | `readOnly=false, destructive=true, idempotent=true, openWorld=true` |
| `crm_create_task` | Escrita | `crm:create` | Requer `AGENDOR_CRM_TOKEN` configurado | `readOnly=false, destructive=true, idempotent=true, openWorld=true` |
| `crm_enrich_organization` | Escrita | `crm:enrich` | Requer `AGENDOR_CRM_TOKEN` configurado | `readOnly=false, destructive=true, idempotent=true, openWorld=true` |
| `crm_enrich_person` | Escrita | `crm:enrich` | Requer `AGENDOR_CRM_TOKEN` configurado | `readOnly=false, destructive=true, idempotent=true, openWorld=true` |
| `crm_enrich_deal` | Escrita | `crm:enrich` | Requer `AGENDOR_CRM_TOKEN` configurado | `readOnly=false, destructive=true, idempotent=true, openWorld=true` |
| `crm_update_task` | Escrita | `crm:enrich` | Requer `AGENDOR_CRM_TOKEN` configurado | `readOnly=false, destructive=true, idempotent=true, openWorld=true` |
| `chat_list_conversations` | Leitura | `chat:read` | Requer `AGENDOR_CHAT_TOKEN` e `AGENDOR_CHAT_ACCOUNT_ID` numérico configurados | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `chat_get_conversation` | Leitura | `chat:read` | Requer `AGENDOR_CHAT_TOKEN` e `AGENDOR_CHAT_ACCOUNT_ID` numérico configurados | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `chat_list_messages` | Leitura | `chat:read` | Requer `AGENDOR_CHAT_TOKEN` e `AGENDOR_CHAT_ACCOUNT_ID` numérico configurados | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `chat_search_contacts` | Leitura | `chat:read` | Requer `AGENDOR_CHAT_TOKEN` e `AGENDOR_CHAT_ACCOUNT_ID` numérico configurados | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `chat_get_contact` | Leitura | `chat:read` | Requer `AGENDOR_CHAT_TOKEN` e `AGENDOR_CHAT_ACCOUNT_ID` numérico configurados | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `chat_list_contact_conversations` | Leitura | `chat:read` | Requer `AGENDOR_CHAT_TOKEN` e `AGENDOR_CHAT_ACCOUNT_ID` numérico configurados | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `chat_list_attachments` | Leitura | `chat:read` | Requer `AGENDOR_CHAT_TOKEN` e `AGENDOR_CHAT_ACCOUNT_ID` numérico configurados | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `chat_get_attachment` | Leitura | `chat:read` | Requer `AGENDOR_CHAT_TOKEN` e `AGENDOR_CHAT_ACCOUNT_ID` numérico configurados | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `automation_preflight_sync` | Leitura | `automation:process`, `chat:read`, `crm:read` | Requer CRM (`AGENDOR_CRM_TOKEN`) e Chat (`AGENDOR_CHAT_TOKEN` + `AGENDOR_CHAT_ACCOUNT_ID` numérico) configurados | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `automation_discover_pending` | Escrita | `automation:process`, `chat:read`, `crm:read` | Requer CRM (`AGENDOR_CRM_TOKEN`) e Chat (`AGENDOR_CHAT_TOKEN` + `AGENDOR_CHAT_ACCOUNT_ID` numérico) configurados | `readOnly=false, destructive=true, idempotent=true, openWorld=true` |
| `automation_prepare_sync` | Escrita | `automation:process`, `chat:read`, `crm:read` | Requer CRM (`AGENDOR_CRM_TOKEN`) e Chat (`AGENDOR_CHAT_TOKEN` + `AGENDOR_CHAT_ACCOUNT_ID` numérico) configurados | `readOnly=false, destructive=true, idempotent=true, openWorld=true` |
| `automation_submit_analysis` | Escrita | `automation:process`, `chat:read`, `crm:read` | Requer CRM (`AGENDOR_CRM_TOKEN`) e Chat (`AGENDOR_CHAT_TOKEN` + `AGENDOR_CHAT_ACCOUNT_ID` numérico) configurados | `readOnly=false, destructive=true, idempotent=true, openWorld=true` |
| `automation_apply_plan` | Escrita | `automation:process` | Requer CRM (`AGENDOR_CRM_TOKEN`) e Chat (`AGENDOR_CHAT_TOKEN` + `AGENDOR_CHAT_ACCOUNT_ID` numérico) configurados | `readOnly=false, destructive=true, idempotent=true, openWorld=true` |
| `automation_get_operation` | Leitura | `automation:read` | Requer CRM (`AGENDOR_CRM_TOKEN`) e Chat (`AGENDOR_CHAT_TOKEN` + `AGENDOR_CHAT_ACCOUNT_ID` numérico) configurados | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `automation_get_customer_context` | Leitura | `automation:read`, `chat:read`, `crm:read` | Requer CRM (`AGENDOR_CRM_TOKEN`) e Chat (`AGENDOR_CHAT_TOKEN` + `AGENDOR_CHAT_ACCOUNT_ID` numérico) configurados | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `automation_list_reviews` | Leitura | `automation:read`, `chat:read`, `crm:read` | Requer CRM (`AGENDOR_CRM_TOKEN`) e Chat (`AGENDOR_CHAT_TOKEN` + `AGENDOR_CHAT_ACCOUNT_ID` numérico) configurados | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `automation_resolve_review` | Escrita | `automation:manage`, `chat:read`, `crm:read` | Requer CRM (`AGENDOR_CRM_TOKEN`) e Chat (`AGENDOR_CHAT_TOKEN` + `AGENDOR_CHAT_ACCOUNT_ID` numérico) configurados | `readOnly=false, destructive=true, idempotent=true, openWorld=true` |
| `automation_get_status` | Leitura | `automation:read` | Requer CRM (`AGENDOR_CRM_TOKEN`) e Chat (`AGENDOR_CHAT_TOKEN` + `AGENDOR_CHAT_ACCOUNT_ID` numérico) configurados | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `automation_list_audit` | Leitura | `automation:read` | Requer CRM (`AGENDOR_CRM_TOKEN`) e Chat (`AGENDOR_CHAT_TOKEN` + `AGENDOR_CHAT_ACCOUNT_ID` numérico) configurados | `readOnly=true, destructive=false, idempotent=true, openWorld=true` |
| `automation_update_policy` | Escrita | `automation:manage` | Requer CRM (`AGENDOR_CRM_TOKEN`) e Chat (`AGENDOR_CHAT_TOKEN` + `AGENDOR_CHAT_ACCOUNT_ID` numérico) configurados | `readOnly=false, destructive=true, idempotent=true, openWorld=true` |
| `automation_reprocess` | Escrita | `automation:manage`, `chat:read`, `crm:read` | Requer CRM (`AGENDOR_CRM_TOKEN`) e Chat (`AGENDOR_CHAT_TOKEN` + `AGENDOR_CHAT_ACCOUNT_ID` numérico) configurados | `readOnly=false, destructive=true, idempotent=true, openWorld=true` |

## Notas sobre autorização em tempo de execução

- A presença de uma ferramenta em `tools/list` não concede permissão OAuth ao cliente chamador.
- `automation_apply_plan`: além de `automation:process` anunciado em `_meta`, o servidor deriva e exige em tempo de execução os escopos CRM (`crm:create`, `crm:enrich` ou `crm:write`) de todos os comandos do plano, além de política em modo `apply`.
- `automation_update_policy`: além de `automation:manage` anunciado em `_meta`, exige os escopos CRM correspondentes às capacidades habilitadas no patch.
- Os adaptadores CRM mantêm a validação de escopo OAuth e falham fechados quando `AGENDOR_CRM_TOKEN` não está configurado.
