# Agendor Chat → CRM sob demanda — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ampliar as ferramentas MCP para que um agente autorizado interprete pedidos no Chat, consulte memória por cliente e crie/complete empresas, pessoas e principalmente negócios corretamente no Agendor CRM.

**Architecture:** O agente chama preparar → analisar → aplicar → conferir. O Worker recupera dados canônicos, entrega contexto versionado e valida os fatos enviados; um coordenador SQLite por conta guarda identidades, demandas, planos, operações e Markdown. Queue executa operações autorizadas e recupera falhas; webhook é otimização de ingestão, sem iniciar inferência.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects SQLite, Queues, Zod e OAuth existentes. Preservar Node >=22.19.0, MCP SDK 2.3.1, Agents 0.29.0 e lockfile atual; verificar APIs contra as versões instaladas antes de atualizar dependências.

**Spec:** [desenho consolidado](../specs/2026-10-23-chat-to-crm-automation-design.md) e [modelo de contexto](../../../templates/cliente-contexto.md).

**Data:** 2026-10-26, America/Cuiaba. Plano solicitado pelo usuário; este documento não executa implantação nem altera o CRM.

## Global Constraints

- A interpretação pertence ao próprio agente conectado ao MCP. Não usar API, SDK ou chave da OpenAI, nem substituir por outro provedor implicitamente.
- O fluxo principal é sob demanda. Não exige agenda, computador específico ou conversa Codex permanentemente aberta; exige que o agente complete a sequência MCP.
- Pedido explícito de serviço/análise com dados identificáveis permite iniciar cadastro parcial. Dados enviados depois completam a demanda.
- Cliente iniciou a abordagem: Passivo. Elo iniciou: Ativo. Etapas: Nova solicitação; Elaborando proposta; Análise interna (aprovação); Proposta enviada. Aprovação interna é dentro da Elo.
- Contexto Markdown por cliente fica no backend, com identidade estável, fontes e versão; CRM/Chat atuais orientam reconciliação.
- Preservar login do proprietário, URL MCP, ferramentas existentes e seus escopos. Escopos atuais não concedem novas criações/enriquecimento implicitamente.
- Não expor HTTP genérico, exclusão, mesclagem destrutiva, criação de catálogo, ganho/perda automático ou envio de mensagens Chat.
- Chat permanece somente leitura pelas ferramentas de atendimento; eventual assinatura de webhook é configuração operacional separada.
- Escritas usam rotas fixas, IDs validados, allowlists, comparação de estado e conferência posterior. POST incerto não é repetido cegamente.
- Um negócio possui vínculo principal com empresa ou pessoa. dealStage de escrita é sequência; funnel é ID.
- Quatro chamadas por dez segundos por produto é o teto local inicial compartilhado entre MCP e automação, não a cota oficial do Chat.
- Cinco tentativas transitórias por versão de trabalho; ambiguidade/validação vira pendência. Inatividade do agente não consome tentativas.
- Evidências/valores históricos de auditoria expiram em 90 dias; vínculos/deduplicação permanecem enquanto integração ativa. Nenhuma limpeza apaga CRM.
- Nenhum segredo ou conteúdo real de clientes em Git, logs técnicos, fixtures ou saída de verificadores.
- Descobertas reais são GETs opt-in, com relatório sanitizado. Testes ordinários usam mocks.
- A árvore atual contém alterações anteriores necessárias e arquivos pnpm não relacionados. Não restaurar, excluir ou incluir esses arquivos em commits por conveniência.
- Produção começa desabilitada/preview. Um único criador por caixa/escopo, mapeamentos reais e autorização do piloto são condições de ativação.

Políticas propostas para revisar antes da ativação: origem incerta conserva pedido como pendência; atendente com correspondência única é responsável inicial; orçamento de serviço definido conta como solicitação; pedidos anteriores com informação nova relevante são elegíveis. O plano usa esses defaults em preview e não os atribui ao usuário como decisões confirmadas.

## Review Focus

1. Dados do cliente chegam depois do pedido, em outra conversa do mesmo contato: recuperar a demanda correta sem duplicar negócio — tarefas 9 e 14.
2. Mais de 20 mensagens, alteração antiga ou cursor incompleto: não declarar histórico completo nem avançar checkpoint indevidamente — tarefas 3 e 12.
3. Dois agentes no mesmo cliente e POST com resposta perdida: conservar reserva, rejeitar versão antiga e reconciliar antes de repetir — tarefas 6 e 11.
4. Dois pedidos semelhantes ou telefone compartilhado: não escolher o primeiro negócio/pessoa nem misturar empresas — tarefa 9.
5. Markdown antigo ou texto de cliente mandando alterar permissões/ganhar negócio: tratar como dado e preservar conflitos observáveis — tarefas 7, 10 e 14.

## Entregas e ordem

| Marco | Tarefas | Entrega verificável |
|---|---|---|
| Contratos e leitura ampliada | 0–3 | Base preservada; catálogo CRM e contexto Chat com cobertura explícita |
| Contratos internos, autorização e memória | 4–7 | Análises tipadas, escopos separados, estado concorrente e contexto .md |
| Escrita e regras comerciais | 8–11 | Cadastro/enriquecimento, resolução, planos e execução recuperável |
| Fluxo exposto e operação | 12–13 | Ferramentas utilizáveis por agentes, pendências e ingestão opcional |
| Validação e publicação | 14–15 | Fluxo comprovado em simulação e piloto delimitado |

É uma cadeia integrada, não projetos independentes. Cada tarefa deixa um componente testável; não iniciar UI, outro backend ou agendador de agente.

## Catálogo de ferramentas expostas

Entradas são objetos estritos; IDs CRM de escrita respeitam int32; requestId é UUID e identifica intenção idempotente. Tipos abaixo são definidos nas tarefas 2–5 e 8. Estes são os nomes a registrar.

### Ferramentas atuais a preservar/ampliar

| Ferramenta | Mudança planejada | Escopo |
|---|---|---|
| server_status | Preservar saúde/identidade; sem disparar processamento | Atual |
| crm_find_person_by_email | Preservar contrato; indicar correspondência por prefixo | crm:read |
| crm_search_people | Acrescentar phone, cpf, organizationId, withCustomFields e filtros de atualização documentados | crm:read |
| crm_search_organizations | Acrescentar cnpj, phone, email, exactName, withCustomFields e filtros documentados | crm:read |
| crm_search_deals | Acrescentar busca textual/funil/etapa/datas e withCustomFields documentados | crm:read |
| crm_get_organization / crm_get_deal | withCustomFields opcional, preservando retorno atual | crm:read |
| crm_list_tasks | Preservar updatedDateGt nos últimos 31 dias e paginação | crm:read |
| crm_update_person / crm_update_organization / crm_update_deal / crm_update_deal_stage | Preservar campos/escopo/retorno; coordenar e registrar intervenção humana | crm:write |
| chat_list_conversations | Filtros e continuação verificados; indicar cobertura incompleta | chat:read |
| chat_get_conversation | Autoria, responsável e vínculos verificáveis; sem objeto cru | chat:read |
| chat_list_messages | after/continuação verificados; autoria/direção/revisão e cobertura | chat:read |

### Novas ferramentas de leitura e cadastro

| Nome novo | Entrada principal | Resultado / escopo |
|---|---|---|
| crm_get_person | id, withCustomFields? | Pessoa completa permitida; crm:read |
| crm_get_task | id | Tarefa e vínculos; crm:read |
| crm_get_configuration | section, entityType?, funnelId?, state?, page?, perPage? | Catálogo validado; crm:read |
| chat_search_contacts | query, continuation? | Contatos/cobertura; chat:read |
| chat_get_contact | contactId | Identificação/atributos selecionados; chat:read |
| chat_list_contact_conversations | contactId, continuation? | Conversas/cobertura; chat:read |
| chat_list_attachments | conversationId | Metadados autorizados; chat:read |
| chat_get_attachment | conversationId, attachmentId | Conteúdo limitado ou indisponibilidade; chat:read |
| crm_create_organization | requestId, record: CreateOrganization | Operação e ID conferido; crm:create |
| crm_create_person | requestId, record: CreatePerson | Operação e ID conferido; crm:create |
| crm_create_deal | requestId, parent: EntityRef, record: CreateDeal | Negócio ligado à empresa/pessoa; crm:create |
| crm_create_task | requestId, parent: TaskParent, record: CreateTask | Próxima ação vinculada; crm:create |
| crm_enrich_organization | requestId, id, patch: EnrichOrganization | Campos ampliados permitidos; crm:enrich |
| crm_enrich_person | requestId, id, patch: EnrichPerson | Campos/vínculo ampliados; crm:enrich |
| crm_enrich_deal | requestId, id, patch: EnrichDeal | Itens, campos, responsável/vínculo sob política; crm:enrich |
| crm_update_task | requestId, id, patch: UpdateTask | Conteúdo/prazo/responsáveis; crm:enrich |

section aceita somente funnels, stages, customFields, users, products, origins, categories, sectors e cities. entityType obrigatório para customFields; state para cities. Não aceitar rota/URL do chamador. Renomeações para API são explícitas, por exemplo exactName → nameExact.

### Novas ferramentas do fluxo por agente

| Nome novo | Entrada | Resultado / escopos mínimos |
|---|---|---|
| automation_prepare_sync | PrepareInput | Contexto, mensagens, candidatos, catálogo e lease; automation:process + chat:read + crm:read |
| automation_submit_analysis | AnalysisInput | Plano/diff ou pendências, sem escrever CRM; automation:process + chat:read + crm:read |
| automation_apply_plan | planId, planVersion, requestId | operationId/status; automation:process + capacidades CRM de cada operação |
| automation_get_operation | operationId | Recibos/pendências; automation:read |
| automation_get_customer_context | customerId, demandId? | Markdown e versão; automation:read + chat:read + crm:read |
| automation_list_reviews | continuation?, limit? | Pendências paginadas; automation:read + chat:read + crm:read |
| automation_resolve_review | reviewId, expectedVersion, decision | Decisão versionada; automation:manage + chat:read + crm:read; aplicação exige capacidades CRM |
| automation_get_status | {} | Cobertura, fila, modos e erros sanitizados; automation:read |
| automation_update_policy | expectedVersion, patch: PolicyPatch | Configuração/pause/enable validada; automation:manage e capacidades CRM habilitadas |
| automation_reprocess | target, from, to, mode, requestId | Trabalho delimitado; automation:manage + leituras correspondentes |

Criação/enriquecimento utilizam o mesmo executor do fluxo, sem caminho paralelo sem coordenação. Consulta simples, tools/list e server_status não autorizam CRM write.

## Estrutura de arquivos

| Área | Arquivos e responsabilidade |
|---|---|
| Contratos externos | docs/automation-contracts.md; scripts/discover-automation-contracts.mjs; test/fixtures/automation-contracts.ts |
| CRM | src/agendor/crm/catalog.ts; mutations.ts; mutation-schemas.ts; ampliar client.ts, schemas.ts e types.ts |
| Chat | src/agendor/chat/types.ts; contacts.ts; attachments.ts; ampliar client.ts e schemas.ts |
| Contratos internos | src/automation/types.ts; schemas.ts; policy-types.ts |
| Persistência | src/automation/state/account.ts; migrations.ts; repository.ts; budget.ts |
| Contexto | src/automation/context/render.ts; service.ts |
| Domínio | src/automation/identity.ts; demands.ts; planner.ts; stages.ts; fields.ts |
| Operações | src/automation/operations.ts; executor.ts; queue.ts; reconciliation.ts |
| Fluxo | src/automation/service.ts; authorization.ts; maintenance.ts; ingress.ts |
| MCP | src/mcp/tools/crm-catalog.ts; crm-create.ts; crm-enrich.ts; automation.ts; ampliar read.ts/chat.ts/server.ts/security.ts |
| Operação | docs/agent-workflow.md; docs/automation-operations.md; scripts/verify-automation-mcp.mjs |
| Configuração | src/auth.ts, oauth/config.ts, env.ts, index.ts, errors.ts, rate-limit.ts, wrangler.jsonc, vitest.config.ts, .gitignore e bindings gerados |

Arquivos por responsabilidade; não concentrar a feature em client.ts/server.ts. Exemplos de teste são contratos para a execução, não código criado no planejamento.

---

### Task 0: Preparar base isolada preservando o trabalho atual

**Files:** inventário local ignorado em .tooling; plano/spec versionáveis. Nenhuma mudança funcional.

**Interfaces:** Consome estado Git; produz checkout de execução e manifesto do baseline.

- [ ] Registrar git status --short, git diff --stat, branch e arquivos staged antes de editar.
- [ ] Na execução, usar superpowers:using-git-worktrees e verificar anexos existentes. Worktree do HEAD sozinho não contém mudanças atuais de Chat/OAuth/CRM: preparar baseline com patch binário dos arquivos relevantes e cópia explícita dos untracked necessários em src/scripts/test/docs/configuração.
- [ ] Excluir secrets, .dev.vars, .tooling, logs, node_modules e pnpm não relacionados. Não fazer stash/reset nem alterar o índice original para montar a base.
- [ ] Conferir hashes do baseline no checkout de execução e instalar pelo lockfile. Registrar verificações existentes sem atribuir falhas anteriores à feature.
- [ ] Commit local do baseline somente no checkout isolado e dos caminhos inventariados. Sem push/deploy.

**Done:** execução usa o aplicativo atual sem perder mudanças do usuário nem incorporar arquivos alheios.

### Task 1: Confirmar contratos externos e capacidades

**Files:** Create docs/automation-contracts.md, scripts/discover-automation-contracts.mjs, test/fixtures/automation-contracts.ts, test/automation-contract-script.test.mjs; Modify package.json, docs/agendor-chat-api.md.

**Interfaces:** Exportar discoverAutomationContracts({request, emit}): Promise<ContractCapabilities>, com transporte e emissor injetáveis. Produz ContractCapabilities { chatMessageAfter, chatHistory, conversationDiscovery, contacts, attachments, customFields, collectionWriteSemantics }, com verified/unverified/unsupported e referências. Fixtures sintéticas.

- [ ] Escrever testes nativos: somente GET para hosts fixos; nunca imprimir tokens, IDs, mensagens/nomes; diferenciar não confirmado de inexistente.
- [ ] Rodar node --test test/automation-contract-script.test.mjs e observar falha por módulo/contrato ausente.
- [ ] Implementar descoberta opt-in de perfil, mensagens/after, contatos/anexos, catálogo/customFields. Consultar OpenAPI atual e Postman; não testar escrita real nem inventar paginação. Coleções só recebem semântica confirmada por documentação ou fixture autorizada posterior.
- [ ] Rodar teste novamente e integrar ao test:scripts. Descoberta real lê credencial local autorizada, nunca por argumento, e salva somente capacidades/esquemas sanitizados.
- [ ] Commit dos arquivos listados: git commit -m "docs: define verified automation contracts".

**Done:** leitura dirigida pode avançar com cobertura explícita; varredura geral depende de discovery/history comprovados.

**Teste inicial definido (test/automation-contract-script.test.mjs):**
~~~js
test('discovery nunca transmite segredo na saída nem usa escrita', async () => {
  const report = await discoverAutomationContracts({request: mockedGetTransport, emit: captureSafeOutput});
  assert.equal(recordedMethods.every(m => m === 'GET'), true);
  assert.equal(capturedOutput.includes('unit-agendor-key'), false);
});
~~~
mockedGetTransport/captureSafeOutput são helpers do próprio teste com fixtures sintéticas; não usam rede.

### Task 2: Ampliar consultas CRM e expor catálogo

**Files:** Modify src/agendor/crm/{client,schemas,types}.ts e ferramentas CRM de leitura; Create catalog.ts, src/mcp/tools/crm-catalog.ts, test/crm-catalog.test.ts.

**Interfaces:** Produz CatalogSnapshot { version, fetchedAt, accountId, funnels, stages, users, products, customFields, capabilities, coverage }; getConfiguration(input: ConfigurationInput): Promise<CatalogPage>; getPerson(id, options?); getTask(id). Filtros preservam nomes atuais. SearchPeopleInput acrescenta phone?, cpf?, organizationId?, withCustomFields?, updatedAtGt?/updatedAtLt?; SearchOrganizationsInput acrescenta cnpj?, phone?, email?, exactName?, withCustomFields? e datas documentadas; SearchDealsInput acrescenta titleSearch?, funnelIds?, stageId?, stageSequence?, withCustomFields? e filtros de data documentados. titleSearch conflita com query; mapear funnelIds→funnels, stageId→dealStage e stageSequence→dealStageOrder.

- [ ] Escrever testes de filtros (phone/cnpj/organization/withCustomFields), igualdade após prefixo, continuação e seção inválida rejeitada sem fetch.
- [ ] Rodar npm test -- test/crm-catalog.test.ts e observar falha.
- [ ] Implementar GETs fixos e catálogo tipado; resolver nome para ID só quando único. Distinguir ID/sequence e opções de customFields. Cache de catálogo tem validade inicial de 15 minutos, versão e cobertura; produto/campo ambíguo em catálogo incompleto não é associado automaticamente. Preservar filtros/retornos antigos.
- [ ] Registrar crm_get_person, crm_get_task e crm_get_configuration; rodar teste, regressões CRM e npm run typecheck.
- [ ] Commit dos arquivos desta tarefa: git commit -m "feat: expand CRM discovery and read tools".

**Test contract:**
~~~ts
expect(catalog.stages.find(s => s.id === 902)?.sequence).toBe(3);
expect(findExactEmail(prefixResults, 'a@empresa.test')).toHaveLength(1);
expect(() => parseConfiguration({ section: '../../deals' })).toThrow();
~~~
parseConfiguration e findExactEmail são helpers locais de schemas/catalog definidos aqui; igualdade exata também serve à tarefa 9.

### Task 3: Ampliar leitura Chat, contatos, mensagens e anexos

**Files:** Modify src/agendor/chat/{client,schemas}.ts, src/mcp/tools/chat.ts; Create types.ts, contacts.ts, attachments.ts, test/chat-context.test.ts, test/chat-attachments.test.ts.

**Interfaces:** Exportar createConversationReader(deps), cuja função readConversation é produzida pelo reader. Produz ConversationSnapshot { conversationId, revision, contact, messages, attachments, coverage, continuation? }; readConversation(input: ConversationReadInput): Promise<ConversationSnapshot>; readAttachment(input: AttachmentInput): Promise<AttachmentResult>.

- [ ] Escrever testes de after, histórico >20, cursor repetido, edição antiga, autoria/direção, contato em várias conversas e cobertura incompleta.
- [ ] Testar anexos: origem/redirect não permitido, limite de bytes, URL expirada e formato não suportado; nunca encaminhar api_access_token à CDN.
- [ ] Rodar npm test -- test/chat-context.test.ts test/chat-attachments.test.ts e observar falhas.
- [ ] Implementar contatos/anexos documentados. Anexo individual vem da lista autorizada; não inventar endpoint. Manter metadados JSON em até 1 MiB e bytes de um anexo em até 5 MiB, além do limite menor do cliente. Entregar texto/imagem limitados onde suportados e recurso/link compatível para outros formatos; retornar motivo e pendência se indisponível.
- [ ] Registrar cinco ferramentas Chat novas e ampliar três atuais sem retirar campos. Máximo inicial de cinco páginas/100 mensagens por chamada; retornar continuação verificável/missingCoverage, nunca truncar como completo. Páginas adicionais exigem continuação explícita.
- [ ] Rodar testes, test/chat-tools.test.ts e typecheck. Commit: git commit -m "feat: expose expanded Chat context and attachment tools".

**Teste inicial definido (test/chat-context.test.ts):**
~~~ts
it('sinaliza cobertura incompleta quando o cursor repete', async () => {
  const result = await readConversation(repeatedCursorFixture);
  expect(result.coverage.complete).toBe(false);
  expect(result.coverage.missingReasons).toContain('cursor_repeated');
});
~~~
O transporte da fixture é injetado em contacts/client; não existe fetch real no teste.

### Task 4: Definir contratos internos da análise e do fluxo

**Files:** Create src/automation/types.ts, schemas.ts, policy-types.ts, src/agendor/crm/mutation-schemas.ts, test/automation-schemas.test.ts, test/fixtures/automation.ts.

**Interfaces:** Exportar tipos abaixo como z.infer dos schemas; módulos posteriores importam estes tipos, sem cópias divergentes.

~~~ts
type EntityRef = { kind: 'organization' | 'person'; id: number };
type TaskParent = EntityRef | { kind: 'deal'; id: number };
type StageKey = 'new_request' | 'preparing_proposal' | 'internal_approval' | 'proposal_sent';
type SourceRef = { kind: 'message' | 'contact' | 'crm' | 'operator'; id: string; revision: string; field?: string };
type FactValue = string | number | boolean | null | (string | number)[];
type Fact = { entity: 'organization' | 'person' | 'demand'; field: string; value: FactValue; sources: SourceRef[]; certainty: 'confirmed' | 'ambiguous' };
type WorkTarget = { kind: 'conversation'; conversationId: number } | { kind: 'customer'; customerId: string } | { kind: 'pending' };
type PrepareInput = { requestId: string; target: WorkTarget; mode: 'preview' | 'apply' } | { requestId: string; workId: string; leaseToken: string; continuation: string };
type AnalysisInput = { workId: string; leaseToken: string; expectedSnapshotVersion: number; expectedContextVersion: number; analysis: AgentAnalysis };
~~~

AgentAnalysis contém customerSelection (EntityRef ou cadastro novo proposto), facts, demands e ambiguities. Cada demanda contém clientKey estável no trabalho, existingDemandId opcional, serviço/escopo, explicitRequest/fontes, approach client/elotenant/unknown/fontes, stage/fontes, itens candidatos e compromissos. IDs selecionados pertencem aos candidatos do snapshot. Datas/itens são validados antes de virar comandos. Mesma análise/digest retorna o mesmo plano; análise diferente incrementa analysisRevision e invalida planos anteriores do trabalho.

PreparedWork contém workId, leaseToken, expiresAt, snapshotVersion, contextVersion, customerId provisório/canônico, markdown, snapshot, catalogVersion e coverage. SyncPlan contém planId, version, policyVersion, workId, analysisRevision, orderedCommands, before/after, sourceRefs, reviewIds e state ready/review/noop. OperationReceipt contém operationId, commandKey, state, crmRef?, updatedFields e checkedAt?.

- [ ] Escrever testes que rejeitem chaves extras, fontes inexistentes, tipos inválidos, campos fora da allowlist e mistura de start/continue.
- [ ] Rodar npm test -- test/automation-schemas.test.ts e observar falha.
- [ ] Implementar schemas/fixtures e DTOs estritos de escrita da tarefa 8 em mutation-schemas.ts, sem rede. MutationCommand e tipos complementares abaixo também são declarados aqui, permitindo compilar tarefas posteriores sem import inexistente. SourceRef operator é criado somente pelo backend a partir de decisão autenticada de revisão; submit_analysis não pode inventar essa fonte. Campo customizado exige identificador no catálogo e tipo/opções corretos; proteger chaves de protótipo.
- [ ] Rodar testes/typecheck e commit: git commit -m "feat: define typed agent workflow contracts".

**Teste inicial definido (test/automation-schemas.test.ts):**
~~~ts
it('rejeita dados extras e submissão sem referência de versão', () => {
  expect(analysisInputSchema.safeParse({...validAnalysisInput, arbitraryUrl:'https://example.test'}).success).toBe(false);
  expect(analysisInputSchema.safeParse({...validAnalysisInput, expectedSnapshotVersion:undefined}).success).toBe(false);
});
~~~
Exportar analysisInputSchema e prepareInputSchema de schemas.ts; validAnalysisInput pertence a fixtures/automation.ts.

### Task 5: Ampliar OAuth e separar capacidades

**Files:** Modify src/auth.ts, src/oauth/{config,consent,provider}.ts, src/mcp/security.ts, test/auth-scopes.test.ts, test/oauth-resource.test.ts; Create src/automation/authorization.ts, test/automation-scopes.test.ts.

**Interfaces:** AuthContext carrega expiresAt opcional em milissegundos, normalizado uma vez a partir dos segundos OAuth, sem quebrar chamadores. Exportar requireCapabilities(auth, capabilities: readonly string[]): void e authorizePlan(auth, plan: SyncPlan, policy: AutomationPolicy): AuthorizedPlan.

- [ ] Escrever matriz: escopos antigos não criam/enriquecem; automation:process não concede leitura Chat/CRM nem escrita; automation:manage não aplica por si só.
- [ ] Rodar npm test -- test/automation-scopes.test.ts test/auth-scopes.test.ts e observar novas falhas.
- [ ] Acrescentar crm:create, crm:enrich, automation:read, automation:process e automation:manage ao consentimento/discovery. Preservar owner, audience, PKCE, offline_access e validade.
- [ ] Verificar capacidades por operação; prepare exige leituras de ambos os produtos; submit exige identidade do lease. Capturar só identidade/capacidades e prazo da autorização no job, nunca access token.
- [ ] Rodar matriz, regressões OAuth e typecheck. Commit: git commit -m "feat: scope CRM creation and agent processing".



**Teste inicial definido (test/automation-scopes.test.ts):**
~~~ts
it('crm:write legado não concede criação', () => {
  expect(() => requireCapabilities(legacyWriteAuth, ['crm:create'])).toThrow();
});
~~~
legacyWriteAuth é fixture com somente crm:write. Adicionar caso equivalente para automation:process tentando ler contexto sem os dois escopos de produto.

### Task 6: Persistir estado, reservas e orçamento compartilhado

**Files:** Create src/automation/state/{account,migrations,repository,budget}.ts, test/automation-state.test.ts, test/automation-budget.test.ts; Modify src/env.ts, src/index.ts, wrangler.jsonc, vitest.config.ts, test/helpers.ts e bindings gerados.

**Interfaces:** AutomationAccount é Durable Object SQLite, obtido por chave fixa de conta do servidor. Produz reserveWork(ReserveWorkInput): Promise<WorkLease>, installSnapshot(WorkLease, SnapshotManifest): Promise<void>, savePlan(SyncPlan): Promise<void>, getContext(customerId): Promise<CustomerContext>, reserveCommand(CommandReservation): Promise<ReservationResult>, completeCommand(CommandCompletion): Promise<void> e takeBudget(product: 'crm'|'chat', now: number): Promise<BudgetTicket>. Definir entradas/retornos em types.ts; Actor contém userId, clientId, scopes e expiresAt?.

- [ ] Escrever testes reais no runtime Workers para duas reservas simultâneas, replay idempotente, UUID reutilizado com payload diferente, lease expirado, migração reaplicada e restart preservando operação incerta.
- [ ] Testar orçamento por request upstream: quatro reservas em janela móvel de 10.000 ms; a quinta devolve retryAt. Requisição cancelada não devolve crédito que permita rajada.
- [ ] Rodar npm test -- test/automation-state.test.ts test/automation-budget.test.ts; observar falhas.
- [ ] Na ativação, comparar a conta CRM e Chat verificadas com a vinculação persistida; mudança de conta da credencial exige reconfiguração explícita, não reutiliza memória. Implementar migrações numeradas para customers, bindings, identity_reservations, events, work, snapshot_manifest, demands, facts, contexts, plans, commands, reviews, outbox, policy e budget. Transações curtas sem rede. Unique keys de request/comando e CAS de versões; telefone compartilhado não é unique binding de pessoa.
- [ ] Lease inicial de 600 segundos, vinculado ao cliente/usuário e trabalho; fence monotônico. Snapshot persistido guarda IDs/revisões, direção e hashes, sem transcrição integral permanente. Manifesto/claims antigos são invalidados ao mudar a fonte.
- [ ] Configurar AUTOMATION_STATE, chave de conta fixa do servidor elotenant (nunca do chamador), classe AutomationAccount e migration tag automation-v1/new_sqlite_classes; exportar classe em index.ts. Usar APIs de teste do plugin instalado, sem mudar stack de testes por preferência.
- [ ] Integrar orçamento por requisição real nos adaptadores, inclusive páginas internas, removendo dupla cobrança em wrappers. Na produção, factory injeta gate obrigatório; testes de cliente usam stub explícito. Regenerar bindings, rodar testes/typecheck/build dry-run.
- [ ] Commit dos arquivos desta tarefa: git commit -m "feat: persist coordinated automation state".

**Test contract:**
~~~ts
expect((await reserveTwiceSameIntent()).commandKeys).toHaveLength(1);
expect(await state.takeBudget('crm', 1_000)).toMatchObject({ allowed: false, retryAt: 10_000 });
expect(await restartAndRead(uncertainCommandKey)).toMatchObject({ state: 'uncertain' });
~~~
Os helpers são fixtures locais dos testes. O teste de budget reserva antes quatro chamadas em now=0. Política e schemas provêm das tarefas 4–5.

### Task 7: Gerar e expor memória Markdown por cliente

**Files:** Create src/automation/context/{render,service}.ts, test/customer-context.test.ts; Modify docs/templates/cliente-contexto.md, .gitignore.

**Interfaces:** CustomerContext { customerId, version, verifiedAt, markdown, evidenceRefs }; renderCustomerContext(ContextProjection): string; refreshCustomerContext(customerId, expectedVersion): Promise<CustomerContext>. ContextProjection reúne fatos confirmados/ambíguos, contatos, demandas e recibos, sem texto de instruções.

- [ ] Escrever testes de IDs estáveis após renomeação, contato em duas empresas, contexto provisório, correção substituída, duas atualizações concorrentes e sugestão não aplicada.
- [ ] Rodar npm test -- test/customer-context.test.ts e observar falha.
- [ ] Implementar projeção dos fatos/recibos confirmados e renderer determinístico para clientes/<customerId>/contexto.md, guardado em contexts no SQLite. Limite proposto de 32 KiB para resumo; demandas antigas/detalhadas são carregadas por demandId, sem truncar pendências silenciosamente.
- [ ] Atualização exige expectedContextVersion; divergência retorna CONTEXT_STALE. Renderizar só após transação dos fatos/resultados. Não aceitar upload de Markdown livre para alterar identidade, política ou fatos confirmados.
- [ ] Excluir runtime/clientes/ do Git para exportação opcional. Template permanece sanitizado. Rodar testes/typecheck e commit: git commit -m "feat: add versioned customer Markdown context".

**Test contract:**
~~~ts
expect(rendered).toContain('Pendências e ambiguidades');
expect(rendered).not.toContain('proposta enviada: confirmado'); // existe só sugestão
await expect(updateOldContextVersion()).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
~~~

### Task 8: Implementar criação e enriquecimento CRM por rotas fixas

**Files:** Create src/agendor/crm/mutations.ts, test/crm-create-client.test.ts, test/crm-enrich-client.test.ts; Modify src/agendor/crm/mutation-schemas.ts, types.ts, client.ts, src/http.ts e src/errors.ts.

**Interfaces:** CreateOrganization, CreatePerson, CreateDeal, CreateTask, EnrichOrganization, EnrichPerson, EnrichDeal e UpdateTask são schemas estritos. Implementar createCrmMutationClient(deps): CrmMutationClient, com createOrganization, createPerson, createDeal(parent, record), createTask(parent, record), enrichOrganization, enrichPerson, enrichDeal e updateTask. Retorno MutationOutcome é confirmed { ref, returnedFields }, uncertain { reason } ou rejected { code }; HTTP não inventa sucesso de conferência.

- [ ] Escrever testes para rotas/corpos de POST e PUT, propriedades extras rejeitadas antes de fetch, ID int32, catálogo/tipo de customFields e preservação de coleções.
- [ ] Rodar npm test -- test/crm-create-client.test.ts test/crm-enrich-client.test.ts e observar falhas.
- [ ] Implementar POST /organizations, /people, /organizations/{id}/deals ou /people/{id}/deals e tarefas documentadas de empresa/pessoa/negócio. Implementar PUTs fixos; não expor status/author/visibilidade/allowedUsers.
- [ ] Campos permitidos: empresa name/legalName/cnpj/contact/address/website/description/ranking/leadOrigin/category/sector/customFields; pessoa name/role/contact/organization/description/birthday/ranking/customFields, documento/endereço só quando mapeados e necessários; negócio title/description/value/startTime/products_entities/ownerUser/customFields, funnel/dealStage pela operação de etapa, relatedEntity somente relação inequívoca. Tarefa text/type/assigned_users/due_date; conclusão não é inferida.
- [ ] Preservar limites atuais: name/title 150; legalName 255; description empresa/pessoa 700 e negócio 2.000; ranking 0–5; value 0–1.000.000.000.000. Não reutilizar leitura camelCase para escrita snake_case de endereço sem mapper documentado.
- [ ] Tornar explícita ambiguidade de transporte após envio, inclusive timeout/abort/5xx/JSON inválido de POST; não repetir dentro do cliente. Manter GETs e cancelamento existentes. Limitar resposta CRM a 1 MiB como no Chat; tratar Retry-After sem vazar corpo.
- [ ] Verificar checkRequiredFields e sequência/funil, preço/unidade/desconto segundo contrato da tarefa 1. Se coleções não tiverem semântica comprovada, bloquear somente esse patch e gerar pendência.
- [ ] Rodar testes de HTTP/CRM existentes e typecheck. Commit: git commit -m "feat: add bounded CRM creation and enrichment clients".

**Teste inicial definido (test/crm-create-client.test.ts):**
~~~ts
it('rejeita mudança de visibilidade no cadastro', async () => {
  await expect(mutationClient.createPerson({...personFixture, allowedUsers:[1]} as never)).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(upstreamFetch).not.toHaveBeenCalled();
});
~~~
mutationClient usa o transporte mockado do teste e personFixture satisfaz os campos válidos do DTO.

### Task 9: Resolver cliente, vínculos e demanda correta

**Files:** Create src/automation/identity.ts, demands.ts, test/customer-resolution.test.ts, test/demand-resolution.test.ts.

**Interfaces:** resolveCustomer(input: AgentAnalysis, candidates: CustomerCandidates, catalog: CatalogSnapshot): CustomerResolution; resolveDemands(input: AgentAnalysis, customer: CustomerResolution, existing: readonly DemandRecord[]): DemandResolution. Resultados discriminam resolved/create/review e incluem motivos/fontes. Candidate/Record/Resolution definidos em types.ts.

- [ ] Escrever cenários: vínculo CRM válido, documento exato, e-mail por prefixo, telefone compartilhado, homônimos, nenhuma página omitida, pessoa representando outra empresa e nova demanda após negócio encerrado.
- [ ] Escrever casos de pedido + dados posteriores em outra conversa, dois serviços no mesmo pedido e pedidos iguais independentes. Nenhum caso escolhe primeiro candidato por ordem da API.
- [ ] Rodar npm test -- test/customer-resolution.test.ts test/demand-resolution.test.ts e observar falhas.
- [ ] Implementar normalização/igualdade (telefone usa país/DDD verificáveis; número parcial não ganha DDD inventado), evidência de vínculo, criação mínima e reservas de identidade. Não usar upsert por nome como deduplicação universal. Análise só seleciona IDs do snapshot; relação pessoa–empresa não é presumida pelo número do telefone.
- [ ] Gerar demandId no backend; clientKey fica estável entre tentativas da mesma análise. Relacionar propostas/pedidos/projetos explícitos; mera semelhança de serviço não funde demandas. Migrar vínculo principal exige evidência/revisão prevista.
- [ ] Rodar testes/typecheck e commit: git commit -m "feat: resolve customers and service demands safely".

**Test contract:**
~~~ts
expect(resolveSharedPhoneFixture().kind).toBe('review');
expect(resolveComplementInSecondConversation().demandId).toBe(existingDemandId);
expect(resolveTwoIndependentRequests().newDemandCount).toBe(2);
~~~

### Task 10: Planejar preenchimento, funis, etapas e próximas ações

**Files:** Create src/automation/{planner,stages,fields}.ts, test/automation-planner.test.ts, test/stage-evidence.test.ts.

**Interfaces:** buildSyncPlan(analysis: AgentAnalysis, work: PreparedWork, resolution: ResolutionBundle, policy: AutomationPolicy): SyncPlan; decideStage(evidence: StageEvidence, current: DealSnapshot): StageDecision; buildFieldPatch(input: FieldPatchInput): FieldPatchDecision. Estes tipos são definidos em types.ts com ref/patch/reviewReasons/sourceRefs. Planner é puro; não chama rede.

- [ ] Escrever tabela de casos para Ativo/Passivo por origem da demanda, incluindo conversa antiga; origem desconhecida → revisão. Não exigir preço/CNPJ/endereço indiscriminadamente.
- [ ] Testar quatro etapas, nascimento direto em etapa posterior, aprovação dentro da Elo, “vou enviar” vs envio, proposta recebida do cliente e evidência de outro pedido. Movimento regressivo vira revisão; negócio ganho/perdido permanece protegido.
- [ ] Testar campos personalizados com opções, quantidade de amostra vs unidade, logística incluída, preço desconhecido, alteração humana observável e descrição humana perto de 2.000 caracteres.
- [ ] Rodar npm test -- test/automation-planner.test.ts test/stage-evidence.test.ts e observar falhas.
- [ ] Implementar mapa de funil/etapa pelo catálogo, patches apenas de fatos sustentados e região gerenciada de descrição. Backend valida fontes/estruturas/direção, mas não certifica sozinho toda semântica da linguagem: interpretação e casos ambíguos continuam responsabilidade do agente e da política.
- [ ] Separar confirmed/ambiguous/pending; ausência não vira null/zero nem apaga valores. Responsável existente preservado; novo só com usuário ativo inequívoco. Datas relativas usam timestamp e America/Cuiaba; tarefas só com compromisso/regra explícita.
- [ ] Rodar testes/typecheck e commit: git commit -m "feat: plan evidence-backed CRM changes".

**Test contract:**
~~~ts
expect(stageFromClientApproval()).not.toBe('internal_approval');
expect(stageFromFutureSendStatement()).not.toBe('proposal_sent');
expect(planWithoutPrice()).toMatchObject({ canCreateDeal: true, pendingFields: expect.arrayContaining(['value']) });
~~~
canCreateDeal/pendingFields são propriedades do resumo de decisão do planner, usadas para gerar o SyncPlan; nomear PlannerDecision em types.ts. Campo pode ser obrigatório para etapa posterior e então bloquear só essa operação.

### Task 11: Executar planos com idempotência, Queue e reconciliação

**Files:** Create src/automation/{operations,executor,queue,reconciliation}.ts, test/automation-executor.test.ts, test/automation-queue.test.ts; Modify wrangler.jsonc, src/index.ts, src/env.ts, src/errors.ts, bindings.

**Interfaces:** MutationCommand é união tipada de create/enrich organization/person/deal/task, update task e change stage. runPlan(plan: AuthorizedPlan, deps: ExecutionDeps): Promise<OperationStatus>; reconcileCommand(commandKey, deps): Promise<ReconciliationResult>; handleAutomationQueue(batch, env): Promise<void>. OperationStatus contém state queued/running/applied/review/uncertain/authorization_expired, receipts e pendingReasons.

- [ ] Escrever testes de replay, mesmo requestId com payload diferente, concorrência entre agentes, crash após POST antes de salvar, timeout incerto, PUT após edição externa e pausa durante execução.
- [ ] Rodar npm test -- test/automation-executor.test.ts test/automation-queue.test.ts e observar falhas.
- [ ] Implementar comando persistido antes do envio, fence/reserva e execução de dependências. Pedido de aplicar em preview é rejeitado. Operação confirmada não é reenviada; referência criada alimenta apenas dependências autorizadas do mesmo plano.
- [ ] Conferir fonte/CRM/política imediatamente antes e depois de cada escrita. Identificar intervenção dos tools antigos; não prometer proteção absoluta contra escrita simultânea externa sem CAS Agendor.
- [ ] POST incerto conserva reserva e faz GETs de reconciliação; prova única adota ID, inconclusivo vira revisão. Cancelamento depois de envio também é incerto. Não liberar reserva só por lease vencido.
- [ ] Queue recebe somente accountKey/operationId/version. Configurar produtor AUTOMATION_QUEUE, fila elo-agendor-operations e DLQ elo-agendor-operations-dlq; consumer com max_batch_size=1 e max_concurrency=1 no início. Confirmar semântica de max_retries no schema/docs; ledger limita cinco tentativas reais transitórias, independente de entregas duplicadas.
- [ ] Uma aplicação interativa mantém autorização operacional por até 300 segundos, limitada também por expiresAt quando disponível. Depois disso não inicia novas escritas: exige nova chamada autenticada para retomar. GET de reconciliação permanece permitido para resolver efeito enviado; nunca guardar token na Queue.
- [ ] Rodar testes de executor/Queue/cancelamento, typecheck/build dry-run. Commit: git commit -m "feat: execute recoverable CRM sync operations".

**Test contract:**
~~~ts
expect(postCallsAfterDuplicateDelivery).toBe(1);
expect(timeoutResult.state).toBe('uncertain');
expect(await retryUnresolvedCreate()).toMatchObject({ state: 'review' });
expect(newWritesAfterPause).toBe(0);
~~~




### Task 12: Expor o fluxo completo e as ferramentas ampliadas no MCP

**Files:** Create src/automation/service.ts; src/mcp/tools/{crm-create,crm-enrich,automation}.ts; docs/agent-workflow.md; test/automation-tools.test.ts, test/crm-new-tools.test.ts; Modify test/mcp.test.ts, test/helpers.ts, src/mcp/{server,security}.ts, tools/{read,chat}.ts e registradores CRM.

**Interfaces:** createAutomationService(env, auth, signal?) retorna prepare(PrepareInput): Promise<PrepareResult>, submit(AnalysisInput): Promise<SyncPlan>, apply({planId,planVersion,requestId}): Promise<OperationStatus>, getOperation(id), getCustomerContext(customerId,demandId?), listReviews(input), resolveReview(input), getStatus(), updatePolicy(input) e reprocess(input). Retornos e entradas de administração são definidos em types/schemas, com IDs/versões obrigatórios.

- [ ] Escrever testes via callTool/rpc real do projeto para as 26 novas ferramentas do catálogo, descrições, inputSchema, annotations, securitySchemes e escopos. Em ambiente totalmente configurado, verificar 41 ferramentas (15 atuais + 26 novas); manter ausência condicional de produtos não configurados. Nenhum caso não autorizado chega ao upstream.
- [ ] Testar prepare start/continue, submit stale, análise de outra conta/cliente/lease e apply em preview. GET/context/status não criam registros. Fontes ausentes ou catalogVersion antigo exigem nova preparação.
- [ ] Rodar npm test -- test/automation-tools.test.ts test/crm-new-tools.test.ts e observar falhas.
- [ ] Implementar service e registrar todos os nomes do catálogo, incluindo novas ferramentas diretas CRM. Direct tools geram comandos tipados pelo servidor e usam o executor/reservas; requestId reaproveitado com outro payload é rejeitado. Nunca aceitar nome de rota, conta ou capability inventados pelo chamador.
- [ ] Prepare atualiza dados sob demanda, mesmo sem webhook. Entregar status ready/continue/deferred/empty/review e actionRequired analyze/continue/review/done; cursor de continuação é interno, vinculado ao trabalho. Submit persiste análise/plano, não escreve CRM. Apply aceita só versão/política revisadas e capacidades necessárias, retornando operação para acompanhamento.
- [ ] Manter contratos das ferramentas antigas. Legacy updates usam caminho coordenado de um comando, aguardam o resultado limitado pelo sinal e retornam o formato atual {id,updatedFields}; disputa de reserva/orçamento retorna erro transitório seguro. Não exigir escopos novos só para campos antigos.
- [ ] Escrever instruções curtas de servidor e descrições suficientes para qualquer cliente MCP seguir: prepare → ler Markdown/novas mensagens → interpretar → submit → apply conforme política → get_operation → conferir contexto. Anexos não lidos e ambiguidades são declarados; ferramentas não garantem que todo agente obedecerá ao fluxo.
- [ ] Rodar testes MCP, escopos, contrato legado e typecheck. Commit: git commit -m "feat: expose full agent-driven CRM workflow".

**Sequência pública de referência:**
~~~text
automation_prepare_sync({requestId, target:{kind:"conversation",conversationId}, mode:"preview"})
automation_submit_analysis({workId, leaseToken, expectedSnapshotVersion, expectedContextVersion, analysis})
automation_apply_plan({planId, planVersion, requestId})  # somente modo apply/política habilitada
automation_get_operation({operationId})
automation_get_customer_context({customerId})
~~~
No modo preview, a sequência para antes de apply. Em apply já delegado, não pedir aprovação humana por mensagem; pendências reais seguem para revisão. Se retorno é deferred/continue, seguir retryAt/continuação antes de analisar como completo.

**Teste inicial definido (test/crm-new-tools.test.ts):**
~~~ts
it('não expõe criação a concessão antiga', async () => {
  const result = await callTool('crm_create_person', {requestId, record:{name:'Contato teste'}}, configuredEnv, ['crm:write']);
  expect(result.data.result.isError).toBe(true);
  expect(upstreamFetch).not.toHaveBeenCalled();
});
~~~
configuredEnv contém bindings de teste e ferramentas novas; requestId é UUID sintético da fixture.

### Task 13: Operação, revisões, retenção e ingestão opcional

**Files:** Create src/automation/{maintenance,ingress}.ts, test/automation-maintenance.test.ts, test/automation-ingress.test.ts; Modify state repository/account, src/index.ts, wrangler.jsonc, docs/automation-operations.md.

**Interfaces:** maintainAccount(now): Promise<MaintenanceReport>; acceptChatHint(request, env): Promise<Response>; resolveReview(input: ReviewResolution, actor): Promise<ReviewResult>. PolicyPatch aceita mode disabled/preview/apply, caixa/escopo permitidos, mappings, nativeCreatorDisabled e limites — sem credenciais ou HTTP arbitrário.

- [ ] Escrever testes de lease vencido sem tentativa indevida, backoff/429/Retry-After, cinco tentativas, DLQ referenciada, pausa/revogação, limpeza de 90 dias e retenção de chaves de deduplicação.
- [ ] Testar webhook inválido, conta incorreta, repetição, corpo exagerado e aviso sem alteração canônica; nenhum conteúdo do body vira fato sem GET.
- [ ] Rodar npm test -- test/automation-maintenance.test.ts test/automation-ingress.test.ts e observar falhas.
- [ ] Implementar resolução de revisão com CAS. Decisão cliente/demanda/política gera plano novo se versão mudou; aprovação não se aplica ao próximo pedido. Reprocessamento exige alvo/intervalo/mode e novo registro auditável.
- [ ] Implementar manutenção por alarme e watchdog a cada cinco minutos para rearmar outbox/expirar reservas/limpar dados; sem iniciar agente ou inferência. Reagendar falhas persistidas, considerando tentativas finitas de alarmes. Não depender de mensagens novas para recuperar operação parada.
- [ ] Se contrato do webhook for comprovado, habilitar POST /automation/chat-events com conta fixa/validação/limites. Verificar assinatura quando suportada; caso contrário, somente dica para releitura canônica e quota de ingresso. Cadastro da assinatura é configuração deliberada, não ferramenta geral de escrita Chat.
- [ ] Status mostra ready/degraded/paused, pendências, trabalho aguardando agente e cobertura. Logs técnicos apenas códigos/contagens/IDs internos; conteúdos ficam só nas respostas autenticadas pertinentes.
- [ ] Rodar testes/typecheck e commit: git commit -m "feat: add workflow recovery and operational controls".

**Teste inicial definido (test/automation-maintenance.test.ts):**
~~~ts
it('expira evidência histórica e preserva chave de deduplicação', async () => {
  const report = await maintainAccount(nowAfterNinetyDays);
  expect(report.expiredEvidence).toBe(1);
  expect(await repository.hasCommandKey(confirmedCommandKey)).toBe(true);
});
~~~
Semear exatamente uma evidência expirada e um comando confirmado na fixture SQLite.

### Task 14: Validar com agente MCP, cenários completos e verificador seguro

**Files:** Create test/automation-e2e.test.ts, scripts/verify-automation-mcp.mjs, test/automation-verifier.test.mjs; Modify test/fixtures/automation.ts, package.json, docs/agent-workflow.md e docs/automation-operations.md.

**Interfaces:** Verificador usa sessão OAuth local pelos helpers existentes e mode=preview por padrão. Saída resume ferramenta/código/contagem, não mensagens/contatos. Manifesto de piloto explicita conversas, caixas, registros e operações permitidas; escrita exige opção deliberada e autorização do piloto.

- [ ] Escrever testes e2e com adaptadores mockados: pedido + cliente depois; empresa/pessoa parcial; dois pedidos; complemento por outra conversa; Passivo/Ativo; quatro etapas; campos personalizados; itens/logística; tarefas; homônimo; Markdown desatualizado; anexos não lidos; injeção em texto/contexto; POST incerto; escrita humana observável.
- [ ] Escrever teste do verificador: ausência de autorização de escrita implica zero chamadas a create/enrich/apply; escopos faltantes aparecem sanitizados; vazamento de corpo/token falha.
- [ ] Rodar npm test -- test/automation-e2e.test.ts e node --test test/automation-verifier.test.mjs; observar falhas antes de implementar o driver.
- [ ] Implementar driver e npm run verify:automation para leitura/preview. Integrações reais GET são opt-in. O piloto de escrita usa somente alvos do manifesto autorizado; não assumir produção como fixture.
- [ ] Ensaiar com um cliente MCP real: agente interpreta mensagens de cenário sintético ou conversa delimitada em preview, sem API da OpenAI. Comparar sua análise aos resultados esperados antes de ampliar escopo. Confirmar suporte de anexos, encadeamento de ferramentas e autorização.
- [ ] Executar npm test, npm run test:scripts, npm run typecheck e npm run build; integrar o novo teste nativo a test:scripts. Corrigir falhas novas e repetir apenas verificações afetadas.
- [ ] Rodar opt-in GETs e preview se credenciais/conexão disponíveis; registrar explicitamente o que foi verificado e o que depende do piloto, sem escrever CRM como teste ordinário.
- [ ] Commit: git commit -m "test: validate end-to-end agent CRM synchronization".

**Teste inicial definido (test/automation-e2e.test.ts):**
~~~ts
it('completa pedido com dados recebidos depois sem duplicar negócio', async () => {
  const result = await runScenario('request-then-customer-details');
  expect(result.createdDeals).toBe(1);
  expect(result.updatedCustomerContextVersion).toBeGreaterThan(1);
  expect(result.unexpectedPostCalls).toBe(0);
});
~~~
runScenario é helper local do teste que dirige as ferramentas MCP com fixtures e adaptadores mockados, nunca um cliente de IA.

### Task 15: Publicar ferramentas e ativar piloto delimitado

**Files:** Modify README.md, docs/operations.md, docs/deployment.md, docs/automation-operations.md, .dev.vars.example e src/version.ts; configuração/bindings do rollout.

**Interfaces:** RuntimeConfig separa application mode, capacidades, mapeamentos reais, caixas permitidas e estado de criador nativo. Não recebe segredo de IA. Relatório final tem versão publicada, inventário de ferramentas, testes, cobertura, alvos do piloto e limites conhecidos.

- [ ] Conferir que base preservada, suite/typecheck/build e cobertura da matriz abaixo estão aprovados. Revisar diff e credenciais; stage apenas arquivos de tarefas concluídas.
- [ ] Preparar configuração exata de DO/fila/DLQ/watchdog e capacidades de produção, sem alterar conta, endpoint ou owner. Inicialmente disabled/preview. Apresentar destinos, permissões, recursos e manifesto de piloto de forma concreta antes da ativação.
- [ ] Confirmar exclusividade do criador por caixa/escopo: integração nativa desativada nesse domínio ou piloto isolado com desativação comprovada. Caso contrário, bloquear POSTs e manter preview.
- [ ] Provisionar/publicar após autorização concreta do rollout, usando a skill Wrangler apropriada. Reautorizar clientes somente para os escopos novos necessários. Segredos existentes não entram em URLs/arquivos versionados.
- [ ] Verificar tools/list e chamadas válidas/inválidas com concessões antigas e novas; conferir leitura/contexto/preview. Ativar apply só para manifesto autorizado; conferir no CRM cada criação e os vínculos/itens/etapa.
- [ ] Documentar limitação de corrida externa sem CAS, anexos não suportados/cobertura parcial e pendências comerciais. Não declarar automação completa se fases ainda bloqueadas.
- [ ] Registrar pausa/retomada e rollback: bloquear novas reservas, reconciliar efeitos enviados, preservar histórico e estado; rollback de código não desfaz registros CRM.
- [ ] Commit do fechamento: git commit -m "docs: document rollout of expanded Agendor MCP tools".

## Definições complementares para evitar divergências

- AutomationPolicy: version, mode (disabled/preview/apply), allowedInboxIds, capability allowlist, funnel/stage mapping, customField mapping, nativeCreatorDisabled e limites. Alias mappings só aceita IDs verificados do catálogo. Quem ativa precisa ter automation:manage e as capacidades CRM habilitadas.
- AuthorizedPlan: SyncPlan acompanhado do Actor autorizado, capabilities por comando e validUntil. Após prazo, preservar operação e pedir nova chamada autenticada; não continuar novas escritas em background com autorização expirada.
- WorkLease: workId, leaseToken, owner (userId/clientId), fence, expiresAt, mode, target. Nunca incluir leaseToken em Markdown/logs.
- PrepareResult: ready com PreparedWork; continue com dados parciais/manifesto e continuação; deferred com workId/retryAt; empty sem trabalho; review com referências. Parte incompleta não é sucesso completo.
- Coverage: complete boolean e missingReasons por origem/histórico/mensagem/anexo. O pipeline considera a cobertura necessária à decisão, não inventa completude de todo o passado.
- SnapshotManifest: IDs/revisões/hashes das mensagens, autoria/direção, versões de registros/catálogo/contexto e instante de leitura. Conteúdo para o agente é transitório e reconstruído por GET quando necessário.
- MutationCommand: união por kind; commandKey, typed payload/patch, target (ID existente ou referência de criação precedente), dependencies, before snapshot, sourceRefs e requiredCapabilities. Uma referência de criação só pode apontar a comando anterior do mesmo plano.
- CustomerCandidates/CustomerResolution e DemandRecord/DemandResolution: entidades canônicas e propostas discriminadas, com fontes e reviewReasons. ResolutionBundle agrupa ambas. Criação de customerId/demandId é do servidor.
- PlannerDecision: canCreateDeal, pendingFields, commands e reviewReasons. O SyncPlan agrega decisões de cada demanda e executa apenas os comandos independentes permitidos.
- BudgetTicket: allowed e reservationId ou retryAt. Controle por request HTTP real; retry jamais transforma página omitida em fim de histórico.
- ReservationResult/CommandCompletion/ReconciliationResult: states reserved/busy/already_confirmed/uncertain/review e recibo/versão correspondentes, nunca apenas boolean de sucesso.
- ConfigurationInput/CatalogPage/ConversationReadInput/AttachmentInput/AttachmentResult são tipos de leitura das tarefas 2–3. ConfigurationInput é união por section, com entityType obrigatório em customFields, state obrigatório em cities e funnelId obrigatório em stages; catálogo paginado declara coverage. ConversationReadInput contém conversationId, after? e continuation? mutuamente exclusivos. AttachmentInput contém conversationId/attachmentId, nunca URL. AttachmentResult contém available com MIME/conteúdo MCP suportado ou unavailable com motivo tipado.
- Admin schemas: ReviewResolution exige reviewId, expectedVersion e decision tipada (selectCustomer/selectDemand/correctFacts/approvePlan/reject); PolicyPatch exclui identidade de conta/owner; reprocess exige from <= to e alvo delimitado. approvePlan confirma somente a versão indicada e não contorna schema, escopo, identidade ou fonte inválidos. Operação de pausa só muda mode.
- Erros novos em errors.ts: WORK_STALE, CONTEXT_STALE, PLAN_STALE, IDEMPOTENCY_KEY_REUSED, OPERATION_BUSY, WRITE_RESULT_UNCERTAIN, CAPABILITY_UNVERIFIED e AUTOMATION_DISABLED. Erros não carregam corpo upstream ou dados do cliente.
- Padrão de commits: em cada tarefa, git add apenas os caminhos do respectivo Files (e testes/migrations efetivamente relacionados), conferir staged diff e então executar a mensagem indicada. Nenhum git add -A sobre a árvore original suja.

## Matriz de cobertura do desenho

| Requisito / seção da spec | Tarefas |
|---|---|
| Objetivo, ampliação de ferramentas e compatibilidade (1–3/12) | 0–5, 8, 12, 15 |
| Pedido parcial e dados posteriores (4) | 4, 9, 10, 12, 14 |
| Identidade, vínculos e múltiplas demandas (5) | 6, 9, 11, 14 |
| Ativo/Passivo e quatro etapas/aprovação Elo (6) | 2, 4, 10, 14 |
| Produtos, campos, responsáveis, datas, tarefas e preservação (7) | 2, 8, 10, 11, 14 |
| Agente interpreta sob demanda, sem API OpenAI (8) | 4, 5, 12, 14 |
| Contexto .md persistente e versionado (8.1) | 6, 7, 12, 13, 14 |
| Estado, fila, retomada e orçamento (9/11) | 6, 11, 13 |
| Cobertura, paginação, eventos e elegibilidade (10) | 1, 3, 12, 13 |
| Autorização, revisão e pausa (12) | 5, 6, 11–13, 15 |
| Retenção, minimização, métricas e logs (13) | 6, 7, 13–15 |
| Validação, implantação e aceitação (14–15) | Todas; fechamento 14–15 |
| Fora de escopo: envio/status/exclusão/importação em massa | 4, 5, 8, 12, 14 |

## Critérios de conclusão da implementação

- As 15 ferramentas atuais continuam funcionando; as 26 novas estão registradas e autorizadas conforme o catálogo.
- Um agente consegue preparar, ler memória/delta, analisar, submeter, aplicar sob política e conferir negócio/contexto, sem agenda e sem API da OpenAI.
- Empresas, pessoas e negócios são criados/atualizados com vínculos e dados corretos; ambiguidades são visíveis, não preenchidas por suposição.
- Campos personalizados, itens, preços conhecidos, responsável e etapa são conferidos no CRM e documentados com evidência.
- Repetição/concorrência/reinício não repetem criação incerta; propostas obsoletas e conflitos observáveis são interrompidos.
- Contexto por cliente tem ID, fontes, data e versão; sugestões não aparecem como operações concluídas.
- Cobertura e limitações de anexos/contratos são declaradas. Preview e piloto têm resultados registrados, não apenas build bem-sucedido.

## Self-review do plano

Antes de entregar este plano, verificar: catálogo ↔ registradores/testes; tipos ↔ Interfaces de tarefas; cada requisito ↔ matriz; Review Focus ↔ teste de seu proprietário; proporção do plano ↔ desenho; etapas checkáveis sem código de implementação desnecessário. Esta revisão é feita pelo autor, sem novo subagente.

Resultado registrado em 2026-10-26: catálogo com 26 ferramentas novas e preservação das 15 atuais; tarefas 0–15 cobrindo as seções funcionais da spec; análise/leases/planos/contexto usam tipos compartilhados; escopos de leitura dos produtos também protegem memória e diff. Os comandos de teste acima são passos futuros da implementação — não foram executados neste trabalho de planejamento.

## Handoff

Este plano encerra o planejamento solicitado. Implementação só começa após revisão do plano e escolha do modo de execução, conforme writing-plans:

- **Direta nesta conversa:** um implementador segue tarefas/dependências, com revisão final independente.
- **Por subagentes:** implementador e revisor novos por tarefa, com revisão global final; maior custo de contexto.

Recomendação: execução direta, pois os adaptadores, tipos, coordenador e ferramentas compartilham interfaces e se beneficiam de continuidade. Fazer revisão final independente de concorrência, autorização e efeitos incertos antes de ativar escrita.
