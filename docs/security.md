# Segurança

Este documento descreve o modelo de ameaça, os controles de autenticação e autorização, a política de inboxes, os mecanismos de fencing e idempotência e o tratamento de dados externos como evidência não confiável.

## Modelo de ameaça e autenticação

- **Ator único autorizado**: somente a identidade do proprietário (`OWNER_EMAIL`, configurada em `src/oauth/config.ts`) pode autorizar clientes MCP. A verificação ocorre duas vezes: no callback OIDC e em `authenticateClient()` a cada chamada em `/mcp`.
- **OAuth 2.1 + Cloudflare Access OIDC**:
  - O servidor utiliza `@cloudflare/workers-oauth-provider` com PKCE `S256` obrigatório, audiência estrita vinculada ao recurso canônico (`RESOURCE`) e registro dinâmico (`/register`, TTL de cliente de 90 dias; CIMD desabilitado).
  - A autenticação do usuário é delegada ao Cloudflare Access OIDC (One-time PIN por e-mail). Os tokens de identidade são verificados por assinatura `RS256` via JWKS (`ACCESS_JWKS_URL`) com `redirect: 'manual'` (rejeitando redirecionamentos e exigindo HTTP 200), validando `issuer`, `audience`, `nonce`, `iat`, `exp` e `email`.
  - **Tokens e prazos**: access tokens duram **24 horas** (`ACCESS_TOKEN_TTL_SECONDS = 86_400`); refresh tokens duram **35 dias** (`OFFLINE_REFRESH_TOKEN_TTL_SECONDS`) a partir da autorização inicial **somente** quando `offline_access` é consentido.
  - **Sem token fixo**: `MCP_TEST_TOKEN` foi removido permanentemente do código. Autenticação sem Bearer válido ou com token inválido retorna `401` com `WWW-Authenticate` apontando para os metadados do recurso protegido.
- **Rate limiting por superfície**:
  - `MCP_RATE_LIMITER` (`1001`): 30 requisições por janela de 10 s por `clientId` autenticado.
  - `OAUTH_RATE_LIMITER` (`1003`): 30 requisições por janela de 10 s por IP (`CF-Connecting-IP`) nas rotas OAuth (`/authorize`, `/callback`, `/token`, `/token/revoke`, `/register`).
- **Ingresso opcional (`/automation/chat-events`)**: desabilitado (`404`) por padrão (`AUTOMATION_CHAT_HINTS_ENABLED="false"`) por não haver webhook assinado comprovado do Agendor. Mesmo quando habilitado deliberadamente, aceita apenas envelope JSON mínimo (`eventId`, `accountId === AGENDOR_CHAT_ACCOUNT_ID`, `conversationId` positivo) até 8 KiB, máximo de 30 dicas novas/minuto e 1.000 pendentes, nunca cria snapshot/cliente/demanda e não aciona CRM/Chat.
- **Egress e downloads seguros**:
  - O Worker utiliza a flag `global_fetch_strictly_public`.
  - Origens permitidas no código: API Agendor CRM (`api.agendor.com.br`), API Agendor Chat (`chat.agendor.com.br`), emissor Cloudflare Access (`*.cloudflareaccess.com`) e o origin S3 exato observado para anexos do Chat (`agendor-chat-sa-production.s3.sa-east-1.amazonaws.com`).
  - Downloads de anexos validam HTTPS, porta padrão, ausência de credenciais em URL, bloqueio de IPs privados/link-local, até 3 redirects validados contra a allowlist, teto de 20 MiB (`20 * 1024 * 1024` bytes), lista fechada de MIMEs e nunca enviam `AGENDOR_CHAT_TOKEN` para o host S3.
- **Higiene de logs e erros**:
  - `observability.logs.invocation_logs` permanece `false`.
  - Erros expostos ao cliente MCP passam por `SafeError` / `errorData()`, sem vazar tokens, cookies, PINs, headers de autorização ou payloads brutos upstream.
  - Respostas JSON MCP e saída de anexos são limitadas a **512 KiB** (`MAX_TOOL_OUTPUT_BYTES = 524_288`); exceder o limite falha fechado.

## Matriz de escopos OAuth

Os escopos são granulares e **não implicam uns aos outros**. A descoberta em `tools/list` apenas anuncia os requisitos (`_meta.securitySchemes`), nunca concede acesso.

| Escopo | Concede acesso a | Observações e restrições |
|---|---|---|
| *(sem escopo de produto)* | `server_status` | Exige token OAuth válido do proprietário; não contata Agendor. |
| `crm:read` | 10 ferramentas de leitura/busca/catálogo CRM | `crm_get_configuration` e buscas por prefixo exigem verificação de igualdade no retorno. |
| `crm:write` | 4 atualizações legadas (`crm_update_deal`, `crm_update_deal_stage`, `crm_update_person`, `crm_update_organization`) | Não concede `crm:create` nem `crm:enrich`. |
| `crm:create` | 4 criações tipadas (`crm_create_organization`, `crm_create_person`, `crm_create_deal`, `crm_create_task`) | Exige `requestId` e passa pelo executor reservado com leitura `GET` de confirmação. |
| `crm:enrich` | 4 enriquecimentos (`crm_enrich_organization`, `crm_enrich_person`, `crm_enrich_deal`, `crm_update_task`) | Exige `requestId` e validação de campos/catálogo. |
| `chat:read` | 8 ferramentas somente leitura do Agendor Chat | Conta fixa (`7001`); sem endpoints de envio ou alteração no Chat. |
| `automation:read` | `automation_get_operation`, `automation_get_status`, `automation_list_audit`, `automation_get_customer_context`*, `automation_list_reviews`* | *`context` e `reviews` exigem também `chat:read` e `crm:read`. |
| `automation:process` | `automation_preflight_sync`*, `automation_discover_pending`*, `automation_prepare_sync`*, `automation_submit_analysis`*, `automation_apply_plan`** | *Exigem também `chat:read` + `crm:read`. **Apply deriva e exige os escopos CRM de cada comando (`commandCapability`) e `policy.mode === "apply"`. |
| `automation:manage` | `automation_resolve_review`*, `automation_reprocess`*, `automation_update_policy`** | *Exigem também `chat:read` + `crm:read`. **Update policy exige os escopos CRM habilitados no patch. |
| `offline_access` | Emissão de refresh token (35 dias) | Sem este escopo, o token não é renovável. |

Autorizações operacionais (`AuthorizedPlan`) têm validade máxima de **5 minutos** (`300_000` ms) limitada à expiração do token OAuth do ator, e nunca são renovadas em background pela fila ou cron.

## Allowlist de inbox

- A lista autorizada de caixas de entrada é fixa em código em `src/automation/inbox-policy.ts`: `allowedInboxIds = [4101, 4102]`.
- A política armazenada no DO pode apenas restringir esse conjunto (`allowedInboxIds ∩ policy.allowedInboxIds`). Lista vazia nega todas as caixas (fail-closed).
- **Pontos de verificação obrigatórios**:
  1. **Descoberta (`automation_discover_pending`)**: consulta o inventário completo de inboxes da conta e bloqueia a chamada se houver paginação restante, duplicatas ou qualquer ID diferente de `4101` e `4102`.
  2. **Preparação e retomada (`automation_prepare_sync`)**: valida `inboxId` canônico do detalhe da conversa antes de ler mensagens, anexos ou CRM — inclusive em replay pronto ou retomada CRM.
  3. **Execução em fila (`createQueueExecutionDeps.verify`)**: revalida o inbox canônico de todas as conversas associadas antes e depois do despacho da mutação.

## Fencing, leases e idempotência

- **Lease de trabalho (`WorkLease`)**: válido por **600 segundos**, vinculado a `userId`, `clientId`, `workId` e `targetKey`, protegido por `fence` monotônico crescente no DO. Renovar um lease incrementa o fence e invalida manifestos e planos anteriores.
- **Trava de preparação (`preparation_locks`)**: trava SQLite exclusiva por `work_id` com expiração de até **60 segundos** e token de posse (`holder`), impedindo execução simultânea sobre o mesmo trabalho.
- **Base de plano (`PlanBasis`)**: amarra o plano a `workId`, `snapshotVersion`, `contextVersion`, `catalogVersion`, `policyVersion` e `fence`. Qualquer atualização de contexto do cliente (inclusive por outra conversa), mudança de política, revisão ou edição humana observada no CRM invalida o plano.
- **Idempotência por `requestId`**: reutilizar o mesmo `requestId` com payload, alvo, recorte, limites ou ator diferente é rejeitado com conflito (`IDEMPOTENCY_CONFLICT` / HTTP 409). Repetir exatamente o mesmo pedido devolve/recupera a operação ou lease existente sem gerar escrita duplicada.
- **Ledger de comandos e tombstones**: cada comando reservado grava token durável de envio antes da chamada mutável no CRM. Resultado desconhecido ou reserva abandonada (> 30 s) permanece `uncertain` e permite apenas reconciliação por `GET`, nunca outro `POST`. `execution_tombstones` sobrevivem à limpeza de retenção de 90 dias.

## Registros tratados como evidência não confiável

- Todo conteúdo proveniente do Agendor Chat (textos de mensagens, nomes, e-mails, metadados de contatos, nomes/corpos de anexos), textos livres de registros do CRM e o próprio resumo Markdown de contexto são tratados estritamente como **evidência não confiável** (*untrusted data*).
- Instruções de prompt contidas em mensagens ou anexos não podem conceder escopos, alterar política/funil, simular aprovação humana ou contornar revisões.
- Buscas por prefixo no CRM e coleções parciais do Chat nunca comprovam unicidade ou ausência por si só; ambiguidades, cobertura incompleta, duplicidades detectadas e ausência de `nativeCreatorDisabled` seguem para revisão humana (`review`).

## Códigos de erro

As falhas expostas via `SafeError` / `errorData()` distinguem permissão OAuth, bloqueio por política, trabalho obsoleto e conflito de idempotência em quatro categorias principais:

| Código | Status HTTP | Quando ocorre |
|---|---|---|
| `MCP_UNAUTHORIZED` | `401` / `403` | Identidade ausente ou inválida, autorização OAuth expirada ou escopo OAuth insuficiente (`src/auth.ts` e `automationActor` em `src/automation/usecases/context.ts`). Quando falta um escopo, a resposta inclui `requiredScope`. |
| `POLICY_BLOCKED` | `403` | Recusa por estado ou modo da política de automação (por exemplo, `mode !== 'apply'`, versão divergente ou capacidade desabilitada na política) ou por inbox fora da allowlist/escopo autorizado. |
| `WORK_STALE` | `409` | Trabalho, lease, continuação, plano ou cursor de descoberta indisponível, expirado ou obsoleto, ou conversa que mudou durante a descoberta/verificação (`unavailable` e `src/automation/discovery.ts`). Exige nova descoberta ou preparação. (`CONTEXT_STALE`, também `409`, permanece exclusivo para conflitos de versão do contexto do cliente.) |
| `CONFLICT` | `409` | Reutilização de `requestId` com payload ou ator diferente em chamadas diretas (`src/automation/direct.ts`). |
