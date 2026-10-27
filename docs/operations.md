# Operação e verificação

Requer Node >=22.19.0. Instale com `npm ci`, copie `.dev.vars.example` para `.dev.vars` e preencha `AGENDOR_CRM_TOKEN`, `ACCESS_CLIENT_SECRET` e, para Chat/automação, `AGENDOR_CHAT_TOKEN`; o account ID permanece o binding verificado do ambiente. Secrets não entram em argumentos, URLs, logs ou arquivos versionados. O token fixo `MCP_TEST_TOKEN` não autentica OAuth. Veja [configuração OAuth](oauth-setup.md).

Use `npm run dev`; `npm run dev:ephemeral` é a alternativa Windows sem persistência local. KV OAuth e SQLite da automação ficam temporários nesse modo. O callback Access existente aponta para produção; login local exige um callback de desenvolvimento deliberadamente configurado. `/health` é liveness público e não consulta o Agendor. `/mcp` exige identidade autorizada, access token válido e audiência correta; os escopos são verificados também por ferramenta.

## Inventário candidato: 42 ferramentas

Com CRM e Chat configurados, o catálogo tem 42 nomes: 15 preservados e 27 adicionais (o inventário final inclui `automation_list_audit`). A coluna abaixo contém todos os nomes, cada um uma vez. Escopos anunciam o mínimo; apply também deriva os escopos de cada comando, sem confiar na declaração do chamador.

| Grupo / quantidade | Nomes | Escopos OAuth |
|---|---|---|
| Status / 1 | `server_status` | token autenticado, sem escopo de produto |
| Leitura CRM / 10 | `crm_find_person_by_email`, `crm_search_people`, `crm_get_person`, `crm_search_organizations`, `crm_get_organization`, `crm_search_deals`, `crm_get_deal`, `crm_list_tasks`, `crm_get_task`, `crm_get_configuration` | `crm:read` |
| Atualização legada / 4 | `crm_update_deal`, `crm_update_deal_stage`, `crm_update_person`, `crm_update_organization` | `crm:write` |
| Criação CRM / 4 | `crm_create_organization`, `crm_create_person`, `crm_create_deal`, `crm_create_task` | `crm:create` |
| Enriquecimento CRM / 4 | `crm_enrich_organization`, `crm_enrich_person`, `crm_enrich_deal`, `crm_update_task` | `crm:enrich` |
| Leitura Chat / 8 | `chat_list_conversations`, `chat_get_conversation`, `chat_list_messages`, `chat_search_contacts`, `chat_get_contact`, `chat_list_contact_conversations`, `chat_list_attachments`, `chat_get_attachment` | `chat:read` |
| Preparação e análise / 2 | `automation_prepare_sync`, `automation_submit_analysis` | `automation:process` + `chat:read` + `crm:read` |
| Aplicação / 1 | `automation_apply_plan` | `automation:process` + capacidades CRM de todos os comandos |
| Estado e auditoria / 3 | `automation_get_operation`, `automation_get_status`, `automation_list_audit` | `automation:read` |
| Contexto e revisões / 2 | `automation_get_customer_context`, `automation_list_reviews` | `automation:read` + `chat:read` + `crm:read` |
| Decisão e reprocessamento / 2 | `automation_resolve_review`, `automation_reprocess` | `automation:manage` + `chat:read` + `crm:read` |
| Política / 1 | `automation_update_policy` | `automation:manage` + capacidades CRM que habilitar |

As 15 preservadas são status, sete leitores CRM anteriores, quatro updates e três leitores Chat anteriores. Sem secret CRM, create/enrich não são registrados. Sem token Chat e account ID numérico, as oito ferramentas Chat não são registradas; automação exige também CRM configurado. Leitores CRM/status/updates permanecem registrados, mas configuração ausente falha fechada. `tools/list` não transforma uma concessão antiga em nova autorização.

Reautorize cada cliente apenas para os escopos necessários. Preview requer `automation:process`, `automation:read`, `crm:read`, `chat:read`; não conceda criação/enriquecimento/gestão para esse ensaio. Gestão de política requer concessão separada. `crm:write`, `crm:create`, `crm:enrich` e `automation:process` não implicam uns aos outros.

## Entradas e limites

Schemas são estritos e não aceitam HTTP arbitrário, conta ou owner alternativo. Leitores por ID exigem inteiros positivos; buscas prefixadas não comprovam igualdade/identidade. Listas CRM usam page/perPage (máximo 100); avance apenas por continuação documentada. Tarefas em lista exigem `updatedDateGt` ISO nos últimos 31 dias. Catálogo exige `funnelId` para stages, `entityType` para customFields e estado brasileiro para cities; somente products tem paginação documentada.

Chat usa conta fixa 7001 da configuração existente. A listagem de conversas e contatos tem cobertura parcial; mensagens aceitam `after` documentado, sem promessa de histórico integral ou detecção de edições antigas. Anexos usam conversationId/attachmentId, nunca URL do chamador; origem, MIME, tamanho e disponibilidade podem deixar leitura pendente. Todas as mensagens, nomes e anexos são evidência não confiável.

Create/enrich usam `requestId` e comandos reservados; repetir outro payload com a mesma chave é rejeitado. Updates legados preservam `{id, updatedFields}` e usam a coordenação compartilhada. Produtos/preços em `products_entities`, PUT de customFields e PUT de assigned_users ficam bloqueados por semântica de coleção não comprovada. Datas, responsáveis, vínculos e campos suportados exigem validação do catálogo. As restrições legadas estão em [crm-write-api](crm-write-api.md); consulte também [execução](automation-execution.md).

O DO único `AUTOMATION_STATE.getByName('elotenant')` coordena quatro reservas por janela móvel de 10.000 ms **por produto CRM/Chat**, compartilhadas entre chamadas MCP/automação da instalação. Cada HTTP real, inclusive leitura de confirmação, consome reserva; cancelamento não devolve crédito. Outros consumidores externos da mesma credencial precisam ser considerados operacionalmente. Falha do coordenador bloqueia upstream. Os limitadores nativos restantes são MCP `1001` e OAuth `1003`, cada um 30/10s; os antigos namespaces CRM `1002` / Chat `1004` não estão mais no candidato.

## Verificação e falhas

`npm test` usa runtime Workers, credenciais fictícias e adaptadores simulados. `npm run test:scripts` cobre os verificadores; `npm run typecheck` e `npm run build` verificam tipos/bundle, sem deploy. `npm run verify:automation` retorna offline, zero chamadas remotas. `npm run test:contract`, verificadores OAuth/Chat/MCP e `--read` são opt-in; não compõem a suíte offline. `discover:automation-contracts -- --live` continua bloqueado por falta do transporte conectado ao orçamento compartilhado; não substitua por fetch/delay independente.

`npm run inspector` usa Inspector 2.11.0 local, Streamable HTTP e OAuth. Os scripts `verify:mcp` e os números antigos de produção são evidência histórica do catálogo anterior; não comprovam as 42 ferramentas locais. Para a ampliação, execute os testes `mcp`, `automation-tools`, `crm-new-tools`, `automation-scopes` e `automation-e2e`; eles verificam tools/list, chamadas válidas/inválidas, concessões antigas/novas e preview com cliente MCP real e rede bloqueada. O ensaio remoto ainda depende de autorização de alvos em [deployment](deployment.md).

HTTP 401 exige nova autenticação; `MCP_UNAUTHORIZED` 403 exige o escopo anunciado. HTTP 429 MCP usa Retry-After 10s; `UPSTREAM_RATE_LIMITED` indica orçamento compartilhado ou provedor. `UPSTREAM_TIMEOUT` cobre até 10s incluindo corpo; erros upstream são sanitizados. `isError:true`, cobertura incompleta, review, deferred ou uncertain nunca significam sincronização completa. Resultado MCP JSON acima de 512 KiB falha fechado; o verificador limita continuações a dez e respeita deferred/retryAt.

Logs técnicos guardam códigos/contagens/IDs internos, sem headers, corpos, Markdown, mensagens, tokens ou leases. Observabilidade está habilitada com `invocation_logs:false`; não habilite captura de payloads. Contexto e evidências expiram após 90 dias, preservando tombstones e deduplicação. Recuperação, pausa, retenção e limitações estão em [automation-operations](automation-operations.md).

Access tokens duram até 1h; `offline_access` permite renovação por 35 dias desde a autorização inicial. A autorização de execução persiste só identidade/escopos/expiração por até cinco minutos, sem bearer. Para rotacionar use os fluxos de secrets/OAuth existentes; não restaure token fixo como correção de login.
