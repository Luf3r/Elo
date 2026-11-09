# Rollout candidato da ampliação — 2026-10-27

## Publicação atual — 2026-11-03

O Worker `elo-agendor-mcp` está na versão `c53c5538-4cd5-4e09-af92-b6cfc39cb00f` (100%), publicada após corrigir a validação estrita de metadados de anexos nos snapshots de automação. Smoke checks: `/health` e `server_status` `ok`; política de automação `apply`, versão 5, sem operações ou revisões pendentes. A execução local informada pelo usuário passou com 43 arquivos e 612/612 testes. Nenhuma escrita CRM foi realizada neste deploy. A cobertura de conversas segue parcial quando a API não informa fim de paginação.

## Atualização de confiabilidade Chat — 2026-10-28

Atualização técnica autorizada do Worker existente `elo-agendor-mcp`: versão `45325820-bd85-4545-805f-3ae124e288ac` (100% no deployment). Mantidos endpoint, variáveis, secrets, bindings e política remota; nenhum secret foi escrito e nenhuma escrita CRM foi executada. Smoke test pós-deploy confirmou a leitura de um anexo autorizado como `audio/ogg`, 25,408 bytes, completo. A allowlist só inclui o origin HTTPS exato retornado pelo redirect observado. As evidências e limitações de paginação estão em [confiabilidade Agendor Chat](agendor-reliability.md).

**Estado: publicado em modo disabled, sem piloto real autorizado.** A versão de aplicação permanece **0.1.2**, derivada de `package.json` por `src/version.ts`; a versão publicada deste fechamento é `4da0255e-db66-4a85-a19d-346cf60d2ea3`. A última publicação registrada nestes documentos é `9a62a3b3-1750-484c-a811-6547efba2611` (catálogo de 15 ferramentas). Esse registro histórico não é uma consulta atual ao tráfego. Os parágrafos históricos abaixo não comprovam publicação da ampliação de 42 ferramentas.

## Destino e recursos preparados

Este fechamento não executa provisionamento, secret put, upload, deploy, alteração de tráfego ou mudança de política remota. O destino mantém Worker `elo-agendor-mcp`, owner OAuth `owner@elo.example`, origem `https://elo-agendor-mcp.example.workers.dev`, endpoint `/mcp`, conta lógica DO `elotenant` e Agendor Chat account `7001`. Os endpoints Access e a identidade configurados permanecem os existentes em `wrangler.jsonc`/`src/oauth/config.ts`.

| Recurso | Configuração exata preparada em `wrangler.jsonc` | Estado deste fechamento |
|---|---|---|
| Runtime | compatibility_date `2026-10-21`; `nodejs_compat`, `global_fetch_strictly_public` | dry-run local |
| OAuth KV existente | `OAUTH_KV` → `00000000000000000000000000000000` | preservado; sem novo namespace |
| Durable Object | `AUTOMATION_STATE` → classe `AutomationAccount`; nome interno `elotenant` | migração candidata `automation-v1`, `new_sqlite_classes:["AutomationAccount"]`; publicado e aplicado |
| Fila produtora/consumidora | binding `AUTOMATION_QUEUE` → `elo-agendor-operations` | criadas em 2026-10-27; sem mensagens |
| DLQ | `elo-agendor-operations-dlq` | criadas em 2026-10-27; sem mensagens |
| Consumo | `max_batch_size:1`, `max_concurrency:1`, `max_retries:4` | referência de operação somente, sem mensagens/credenciais |
| Watchdog | cron `*/5 * * * *`; manutenção e alarmes do DO | sem inferência; não instalado remotamente aqui |
| Limites nativos | MCP `1001` e OAuth `1003`, 30/10s cada | CRM/Chat usam DO: quatro reservas/10s por produto |
| Ingresso Chat | `AUTOMATION_CHAT_HINTS_ENABLED="false"` | `/automation/chat-events` desabilitado |
| Observabilidade | enabled true, invocation_logs false | sem payloads/headers |
| Secrets | obrigatórios CRM e Access; Chat independente para registrar Chat/automação | nenhum valor transferido ou alterado |

Configuração de aplicação é a política versionada no DO, distinta dos bindings/identidade: `mode`, `capabilities`, `allowedInboxIds`, `funnelMapping`, `stageMapping`, `customFieldMapping`, `nativeCreatorDisabled` e limites. Não existe variável de ambiente `AUTOMATION_MODE` ou segredo de IA a configurar. O [manifesto inicial exato](rollout-pilot.json) reproduz a política padrão `version:1,mode:disabled`, sem capacidades, caixas ou mapeamentos, `nativeCreatorDisabled:false` e limites 10 conversas/20 comandos/20 requests. O arquivo é artefato de revisão, não importado automaticamente pelo runtime; não sobrescreva política remota preexistente assumindo versão 1.

## Bloqueios antes de publicar/ativar

A publicação técnica foi autorizada e concluída no destino existente. As filas foram criadas, a migração SQLite foi aplicada e o Worker foi publicado com política disabled, `AUTOMATION_CHAT_HINTS_ENABLED=false` e sem ativação de escrita. Preserve KV/DO/filas e os secrets existentes; não crie outro endpoint, owner ou conta como fallback.

`allowedInboxIds` e `nativeCreatorDisabled` são campos persistidos de política e agora têm checagem técnica: o preparo/apply rejeita conversas sem `inboxId` ou fora da lista permitida, e o autorizador final rejeita mutações enquanto `nativeCreatorDisabled` não for `true`. A cobertura parcial do Chat continua impedindo alegações de descoberta exaustiva; use preview/review quando a identidade da caixa ou o histórico não puderem ser comprovados.

Não há alvos de leitura real aprovados: `conversations`, `records`, `operations` e evidências de exclusividade estão vazios. O manifesto atual tem `remoteReadAuthorized:false`, `writeAuthorized:false`, `approvedBy:null`, `expiresAt:null` e `requestId:null`; ele é deliberadamente recusado pelo verificador de escrita. Não preencha IDs fictícios como se fossem autorização. Para leitura/preview remoto, autorize primeiro a conversa/caixa e prazo reais e reautorize o cliente apenas com read/process/read-automation necessários.

Piloto futuro de escrita exige aprovação humana concreta do plano já revisado: `approvedBy`, `expiresAt`, requestId do preparo apply, `conversations:[{id,inboxId}]`, `records:[{kind,id}]` e `operations:[{commandKey,kind,sha256}]`, com digest do comando completo via `commandDigest`. Fixe também política/versão, capacidades mínimas, catálogo/mapeamentos verificados e prova do criador nativo fora do manifesto do verificador. Hash/manifesto não substituem os gates do servidor. A publicação não habilita apply por si só; novas concessões não devem ser dadas em bloco.

Foi registrado o UUID Cloudflare `4da0255e-db66-4a85-a19d-346cf60d2ea3` e o smoke test pós-deploy passou: health, autenticação, `tools/list` com 42 ferramentas e quatro leituras CRM autorizadas; nenhum segredo apareceu nos resultados. Contexto/preview e comparações de criação/vínculo/item/etapa no CRM continuam reservados ao piloto autorizado.

## Evidência local e limites

O inventário completo está em [operations](operations.md). A suíte exercita protocolo MCP real em cenário sintético, incluindo concessão antiga que não concede create/enrich, novas permissões, fontes/leases/versões inválidas, preparação/contexto/preview, criação coordenada, reconciliação e retenção. Build dry-run não comprova recursos remotos, exclusividade nativa, catálogo real, completude Chat ou comportamento de agentes de terceiros. Resultados frescos deste fechamento estão em [relatório de verificação](#relatório-de-verificação-local).

Produtos/preços e semântica de substituição de coleções seguem bloqueados; anexos podem ficar pendentes e não há corrida externa totalmente evitável sem CAS upstream. As limitações e o procedimento de pausa/rollback estão em [automation-operations](automation-operations.md). Não declarar automação completa enquanto esses gates e o piloto comercial permanecerem pendentes.

## Relatório de verificação local

Fechamento em 2026-10-27, candidato 0.1.2, sem alteração de comportamento ou de versão do pacote: `src/version.ts` continua como fonte derivada única. Foram executados `npm test` (39 arquivos, **579/579**), `npm run test:scripts` (**26/26**), `npm run typecheck` e `npm run build` (dry-run **1827.03 KiB / 345.42 KiB gzip**), todos aprovados. `npm run verify:automation` retornou `state:offline,remoteCalls:0`. Não houve ensaio de rede real.

| Cobertura exigida | Evidência offline executada | Aceitação real pendente |
|---|---|---|
| 15 ferramentas preservadas e catálogo 42 | mcp, crm-tools, crm-new-tools, automation-tools; tools/list e schemas | publicação + tools/list do candidato |
| Permissões antigas/novas e chamadas inválidas | auth-scopes, automation-scopes, crm-new-tools, automation-tools; zero upstream não autorizado | reautorização mínima dos clientes |
| Pedido parcial, dois pedidos, identidade e etapas | automation-e2e, customer-resolution, demand-resolution, automation-planner, stage-evidence | catálogo e decisões comerciais reais |
| Contexto, fontes, revisão e cobertura | customer-context, chat-context, chat-attachments, automation-review, automation-schemas | anexos e histórico necessários comprovados |
| Concorrência, reserva, retry, pausa e incerteza | automation-state, budget, executor, queue, maintenance, ingress | recursos remotos + exclusividade do criador |
| Verificador e higiene de saída | automation-verifier e testes nativos dos scripts | logs e resultados remotos autorizados |

O fechamento contém a publicação do runtime, documentação e manifesto sem autorização de piloto. Dependências, versão e identidade do Worker foram preservadas; bindings de filas e migração foram aplicados conforme configuração. Documentação registra os bloqueios restantes, sem promover capacidades sem evidência. A conclusão desta tarefa é **publicação técnica do rollout**; preview de automação e ativação/piloto permanecem pendentes.

Verificação adicional offline: 42 nomes únicos na tabela conferem exatamente com os registradores; o manifesto vazio é recusado antes de qualquer chamada de escrita (zero chamadas). Scanner de arquivos versionados e manifesto comparou quatro valores locais conhecidos de secrets sem exibi-los: zero correspondências e zero chaves privadas. git diff --check aprovado.

---

# Histórico anterior à ampliação (preservado)

# Publicação Cloudflare

Estado atual: **OAuth publicado e validado em 2026-10-21**, versão `48f65d8d-d1b9-4d83-8102-e2f46f5b36e6`, no mesmo endpoint MCP. Secret Access preparado na versão não publicada `503a018c-7b45-4dc0-a66a-72235bbbc934` e herdado pelo upload de código, sem tráfego na versão intermediária. Descoberta de recurso/servidor, PKCE S256, CIMD e rejeição da autenticação fixa aprovados em produção. O proprietário concluiu o login real por PIN; o verificador trocou o código com PKCE sem expor credenciais.

Implementação: biblioteca OAuth oficial 1.2.3, jose 6.2.13, KV exclusivo e limitador OAuth1003; access token de 1h, renovação por 35d desde a autorização inicial somente com `offline_access`. Testes 139/139 no Workers, teste de proteção do verificador 1/1, contratos reais CRM 8/8 e JWKS Access 1/1, typecheck e build aprovados. Bundle 1529.69KiB/280.99KiB gzip; startup 58ms informado pelo Wrangler. Revisão independente com dois ajustes corrigidos e verificados.

O primeiro login encontrou uma incompatibilidade de runtime ao buscar as chaves de assinatura OIDC: Workers rejeita `redirect: 'error'`. A versão ativa usa `manual`, sem seguir redirecionamentos; a biblioteca exige resposta 200. Uma regressão unitária e um contrato com o JWKS real reproduziram o erro antes da correção e passaram depois. A validação de assinatura, issuer, audience, nonce e e-mail permanece obrigatória.

Inspector 2.11.0 com a sessão OAuth real: saúde, autenticação, oito ferramentas, `server_status` e quatro leituras CRM (pessoas, organizações, negócios e tarefas) aprovados. Tail durante essa execução: 18 eventos, sem os valores dos secrets, access/refresh tokens ou Authorization completo. Conteúdo CRM e frames brutos não foram exibidos nem gravados. A conexão dentro das interfaces do ChatGPT e Zapia ainda deve ser feita pelo proprietário; não foi testada nessas contas.

## Operação atual

Use os comandos e o procedimento de secrets em [OAuth](oauth-setup.md). Os secrets obrigatórios atuais são `AGENDOR_CRM_TOKEN` e `ACCESS_CLIENT_SECRET`. O token fixo antigo não autentica esta versão. Para o Inspector, conclua `npm run oauth:login` e execute `npm run verify:mcp`; a sessão fica apenas no arquivo local ignorado.

O Worker `elo-agendor-mcp` agora publica também as ferramentas somente leitura do Agendor Chat: `chat_list_conversations`, `chat_get_conversation` e `chat_list_messages`, protegidas pelo escopo `chat:read`. A versão 10 (`9a62a3b3-1750-484c-a811-6547efba2611`) está ativa em 100% do tráfego. O secret `AGENDOR_CHAT_TOKEN` e a variável `AGENDOR_CHAT_ACCOUNT_ID=7001` estão configurados na Cloudflare. Clientes conectados antes da concessão de `chat:read` podem precisar atualizar as ferramentas e reautorizar. Validação MCP autenticada em produção confirmou 15 ferramentas, quatro leituras CRM e chamada bem-sucedida de `chat_list_conversations`; conteúdo de conversas e mensagens não foi exibido. Nenhuma conversa ou registro CRM foi alterado durante a configuração.

## Histórico: publicação com token de teste

Consulte [OAuth](oauth-setup.md) para conectar clientes e operar o novo fluxo. O registro abaixo preserva a versão com token de teste anterior, para rollback; não é a versão ativa.

| Campo | Valor |
|---|---|
| Worker | `elo-agendor-mcp` |
| Conta | `owner@elo.example` |
| Base URL | https://elo-agendor-mcp.example.workers.dev |
| MCP Streamable HTTP | https://elo-agendor-mcp.example.workers.dev/mcp |
| Saúde pública | https://elo-agendor-mcp.example.workers.dev/health |
| Versão histórica | `7e6bdf1d-9f39-4435-959d-b000e1c0674f` |
| Publicação da versão | 2026-10-21 13:15 America/Cuiaba |
| Secrets confirmados | `AGENDOR_CRM_TOKEN`, `MCP_TEST_TOKEN`; valores omitidos |
| Namespace MCP / CRM | `1001` / `1002` |
| Chat | BLOCKED; sem ferramentas ou secret obrigatório |

O usuário autorizou explicitamente o envio dos dois tokens para Cloudflare Secrets e a publicação. Os valores foram transmitidos por stdin do Wrangler, sem arquivo intermediário ou valores em argumentos. A conta inicialmente devolveu erro10034 após a verificação do e-mail; uma nova tentativa liberou a criação do Worker. O subdomínio inicial `example.workers.dev` foi registrado pelo fluxo oficial do Wrangler. A primeira conexão TLS falhou durante a ativação do subdomínio; a repetição posterior passou, sem desativar verificações TLS.

## Evidências da versão publicada

- Instalação `npm ci` aprovada, sem vulnerabilidades no audit; 110 testes unitários/protocolo passando no workerd.
- Oito testes de contrato CRM reais passando, incluindo dados opcionais/nulos, paginação e tarefas por empresa. Contrato Chat explicitamente pulado pelo gate.
- TypeScript e bundle aprovados; upload de 1248.03 KiB / 216.40 KiB gzip; startup informado pelo Wrangler de 64ms.
- Inspector **2.11.0** em produção: saúde 200, Bearer ausente/incorreto 401, oito ferramentas em `tools/list`, `server_status` aprovado e quatro consultas reais de pessoas, empresas, negócios e tarefas aprovadas.
- Tail de produção durante a verificação: **20 eventos**, nenhum valor de segredo e nenhum Authorization completo encontrado. Conteúdo dos registros e frames brutos não foram exibidos nem salvos pelo verificador.
- Arquivos versionados, histórico Git e logs locais produzidos verificados sem os valores dos tokens; `.dev.vars` não versionado.
- Revisão independente concluída; cancelamento propagado até o upstream e coberto por regressões.

`/health` é liveness e não consulta Agendor. A URL MCP responde a clientes MCP autenticados; abrir o endereço no navegador sem Bearer retorna 401, como esperado.

## Procedimentos históricos da versão com token fixo

Os comandos abaixo descrevem a versão histórica e não configuram a publicação OAuth atual. Para a versão ativa, siga [OAuth](oauth-setup.md).

### Gate antes da publicação

```powershell
npm ci
npm run typecheck
npm test
npm run test:contract
npm run build
npm run cf:login
npm run cf:whoami
```

`cf:login` abre o fluxo oficial de autenticação da Cloudflare. Confirme a conta pretendida. Os namespaces nativos 1001 (MCP) e 1002 (CRM) precisam estar disponíveis; se usados por outro Worker, escolha outros inteiros positivos. Nenhum domínio, OAuth de clientes, banco, fila ou Durable Object da aplicação é necessário.

## Segredos e deploy

Configure secrets interativamente, sem valores nos argumentos:

```powershell
npx wrangler secret put AGENDOR_CRM_TOKEN
npx wrangler secret put MCP_TEST_TOKEN
npm run deploy
```

Use os valores guardados localmente, sem colá-los em documentação ou chat. `secrets.required` impede deploy sem os dois nomes. **Não** cadastre AGENDOR_CHAT_TOKEN enquanto o gate estiver bloqueado. `wrangler secret put` pode criar/publicar uma nova versão; trate a operação como alteração de produção.

Para repetir a verificação desta publicação no PowerShell:

```powershell
$env:MCP_URL = 'https://elo-agendor-mcp.example.workers.dev/mcp'
npm run verify:mcp
```

O token é lido do `.dev.vars`; não o passe em argumentos. A checagem precisa comprovar autenticação, descoberta, status e quatro leituras reais. `GET /health` precisa retornar 200 sem token; `/mcp` precisa rejeitar Bearer ausente e incorreto. Aguarde pelo menos dez segundos entre execuções para respeitar o orçamento CRM nativo de 4/10s.

Inspecione logs ao vivo em uma janela controlada e confirme ausência dos valores dos segredos e de Authorization completo. Não habilite logging de headers ou bodies para essa verificação. Registre data, versão implantada e resultados, sem conteúdo CRM.

## Rotação

1. Gere um novo token MCP com fonte criptográfica segura e guarde apenas em `.dev.vars` local.
2. Substitua `MCP_TEST_TOKEN` usando `wrangler secret put` com entrada interativa.
3. Atualize o cliente de teste autorizado.
4. Verifique o token novo com o Inspector.
5. Confirme que o token antigo recebe 401.

Para Agendor, obtenha novo token na conta e substitua `AGENDOR_CRM_TOKEN` pelo mesmo mecanismo. Não exige mudança de código. Para rollback de código use o histórico de versões do Wrangler, preservando o controle de rotação de secrets.
