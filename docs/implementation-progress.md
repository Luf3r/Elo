# SDD ledger — plan: docs/plan.md

Execução inline. Pasta inicialmente vazia, sem repositório, código ou credenciais.

Pre-flight interfaces: 1→2 Wrangler/Env; 2→3 SafeError/Env; 2→4 fetchJson; 3+4→5 auth/client/server factory; 4+5→6 schemas/tools; 1→7 Chat gate; 4→8 real contracts; 5+6→9 Inspector; 1–9→10 deploy. Interfaces compatíveis com as decisões abaixo.

Ruling: workspace novo implementado no diretório solicitado, sem worktree adicional — não havia checkout ou alterações para isolar; custo: nenhum isolamento de branch preexistente necessário.
Ruling: scripts bash da skill não executam neste sandbox Windows (NtCreateDirectoryObject access denied); ledger e evidências mantidos aqui via PowerShell — custo: bookkeeping manual.
Ruling: Agents 0.29.0 exige SDK 2.3.1, usado conforme instrução oficial de respeitar os peers exatos — custo: sintaxe do SDK atual será validada por testes.
Ruling: segundo binding nativo CRM 4/10s necessário, pois 30 requisições MCP/10s permite rajadas e não limita chamadas individuais de ferramentas; limites nativos são aproximados por localização — custo: throughput reduzido e ausência de garantia global estrita sem coordenação fora do escopo.

Ruling: pool Workers 0.23 descontinuado e runtime limitado a 2026-08-22; substituído pelo sucessor oficial vitest-plugin 1.4.6, que suporta a data do projeto — custo: import de testes atualizado.
Ruling: Inspector 2.10.1 inclui SDKs com alertas de segurança; atualizado a 2.11.0 e audit limpo — custo: versão diferente da sugestão, permitido pela verificação da Task 1.

- Tasks 1–6: completas; evidências abaixo.
- Task 7: completa pelo ramo BLOCKED; falta contrato técnico Chat e nenhuma ferramenta Chat está ativa.
- Tasks 8–9: completas com credenciais locais e Inspector real.
- Task 10: completa; dois secrets cadastrados, Worker publicado e Inspector/logs de produção verificados. URL e versão em docs/deployment.md.

Task 1: complete — typecheck e Inspector 2.11.0 --help PASS; commit de39f34. npm audit: zero vulnerabilidades.
Task 2: complete — RED 14 falhas; GREEN 18/18 health+HTTP; typecheck PASS. Workers exige redirect manual, não error; redirects rejeitados e nunca seguidos.

Task 3: complete — RED 23 falhas; GREEN suite 41/41, typecheck PASS. Auth precede limite; segredos ausentes e limiter indisponível falham fechados.

Task 4: complete — OpenAPI oficial V3 verificado; RED 30 falhas; GREEN suite 71/71, typecheck PASS. Nenhuma rota/filtro inventado; tarefas genéricas confirmadas em /tasks.

Task 5: complete — RED 4 falhas; GREEN suite 76/76; typecheck PASS. SDK v2 usa factory nova por requisição; concorrência validada. Testes precisam Host explícito, como no HTTP real.

Task 6: complete — RED 11 falhas; GREEN suite 99/99; typecheck PASS. Sete tools CRM, validação estrita, erros MCP sanitizados, uma chamada GET por tool e texto malicioso tratado apenas como dado.

Task 7: complete (BLOCKED branch) — 7 testes MCP/gate PASS; 1 contrato Chat SKIP explicitamente. Nenhum endpoint Chat, secret obrigatório ou ferramenta Chat.

Task 8: Ruling: API real /tasks exige data inferior com janela de 31 dias, embora OpenAPI marque datas opcionais. Adicionado updatedDateGt explícito para consulta genérica e rotas por entidade documentadas para consultas por ID — custo: parâmetro adicional necessário em tarefas genéricas.
Task 8: complete — regressão tarefas RED 7 falhas + RED janela 1 falha; GREEN suite 104/104, typecheck PASS; contratos reais 8 PASS e 1 Chat SKIP; 429 validado em mocks, sem provocar abuso no provedor.

Task 9: Ruling: Wrangler dev no Windows falha na persistência SQLite; fallback dev:ephemeral usa API Wrangler com persist:false, preservando runtime e bindings — custo: API programática unstable apenas no tooling local.
Task 9: complete — Inspector 2.11.0 modern Streamable HTTP: /health200, sem token401, token incorreto401, tools/list8, server_status, quatro GETs CRM reais PASS. Nenhum segredo encontrado nos resultados. Bundle dry-run PASS (1244KiB/216KiB gzip).

Final review: revisão independente gpt-6-astra. Achado P2 confirmado: cancelamento não chegava ao fetch. Corrigido propagando request.signal e ctx.mcpReq.signal, checando antes/depois do limiter e combinando com timeout. Final: fixed cancelamento — 5 falhas RED → suite 110/110 GREEN; cancelamento antes de envio, durante fetch/corpo e durante limiter cobertos.
Final: Ruling: cancelamentos notificados entre requisições não coordenados — aplicação é stateless, mas todos os sinais disponíveis agora são propagados; custo: sem coordenação persistente de cancelamentos externos.
Final: Ruling: sem limite arbitrário de tamanho de registros além de paginação100 e timeout10s — não há limite documentado do provedor; custo: respostas excepcionalmente grandes podem atingir limites do runtime.
Final: Ruling: OAuth/per-client e Chat fora do escopo/bloqueados conforme plano — custo: não conectar clientes reais permanentemente com o token de teste.
Final review: produção/logs de produção pendentes de autenticação Cloudflare; revisor não abriu segredos locais. Verificação de ausência de segredos executada pelo implementador sem exibir valores.

Task 8 follow-up: Ruling: teste real adicional confirmou que rotas de tarefas por entidade também exigem data inferior; updatedDateGt nos últimos31dias agora é obrigatório em toda consulta de tarefas — custo: parâmetro adicional também para consultas por ID. Regressão RED1 → GREEN110/110, typecheck PASS; 8 contratos reais PASS incluindo campo opcional/nulo e tarefas por empresa.
Task 10: login Cloudflare concluído; conta confirmada; Worker de destino não existe. Auto-review rejeitou envio de secrets por falta de autorização explícita para transferir valores à Cloudflare; nenhum segredo enviado. Pergunta de autorização pendente no chat.

Task 10 update2026-10-21: usuário AUTORIZOU explicitamente transferir os dois tokens para Cloudflare Secrets e publicar. Tentativa Wrangler bulk via stdin chegou à conta correta, mas Cloudflare bloqueou criação do Worker com erro10034: e-mail não verificado. Nenhum secret cadastrado; aguardando confirmação de e-mail. Autorização persiste para retomar.
Cloudflare agent setup: 19skills oficiais instaladas, MCP cloudflare habilitado; OAuth MCP iniciado e aberto no navegador, pendente conclusão. CLIcf opcional omitida porque projeto já usaWrangler. Novos pnpm-lock.yaml/pnpm-workspace.yaml surgiram durante a sessão; preservados sem adicionar aos commits por não fazerem parte destas alterações.

Task 10 diagnóstico: usuário informou verificação concluída; API manteve10034. Identidade confirmada na conta correta; OAuthWrangler renovado com cinco escopos conta/Workers; nova tentativa manteve10034. Cadastrosecrets/deploy ainda não concluídos. MCPCloudflare autenticado (auth_statuso_auth), 19skillsinstaladas. npm test110/110, typecheck e build novamente PASS após layoutnode_modules mudar por instalação pnpm externa; arquivos pnpm preservados.

Task 10: complete — após confirmação do perfil verified, dois secrets cadastrados via stdin; subdomínio inicial example.workers.dev registrado pelo Wrangler; Worker publicado em https://elo-agendor-mcp.example.workers.dev, versão7e6bdf1d-9f39-4435-959d-b000e1c0674f. Inspector2.11.0 em produção: health200, auth401 ausente/incorreto, tools8, statusPASS, quatro leituras reaisPASS. Tail20eventos sem tokens/Authorizationcompleto; scannerGit/logs sem vazamentos. Primeiro TLS falhou durante ativação; repetição aprovada sem alterar segurança.
Ruling: subdomínio de conta ausente — registrado example.workers.dev, baseado na identidade autenticada, para cumprir a publicação workers.dev autorizada; custo: namespace público da conta passa a usar esse nome.
Final: nenhuma questão crítica/importante restante; nenhuma melhoria menor adiada. Chat continua no ramo BLOCKED previsto, não é bloqueio do CRM. Arquivos pnpm externos preservados sem commit.

## 2026-10-28 — confiabilidade Agendor Chat → CRM

Desenho aprovado pelo usuário; execução inline. Branch original codex/agendor-reliability-local. Worktree auxiliar foi criado, mas o sandbox não permitiu editá-lo; implementação feita no diretório autorizado. A aplicação não permitiu arquivar o worktree por considerá-lo checkout primário.

Ruling: usar evidência de paginação de mensagens fornecida pelo usuário (42/203), separada de contrato documental e teste live nesta sessão. Após falhas de navegação/terminal, Postman foi acessado pelo navegador; after e rotas confirmados. Paginação de coleções e CDN reais permanecem pendentes; não inventar hosts nem substituir orçamento remoto por delay local.

Implementado: allowlist 4101/4102 e vazio fechado; mensagem after=1, continuação e cobertura; metadados de coleções, batches e estado parcial específico; anexos/mídias reconciliados; downloads HTTPS/hosts exatos/3 redirects/20MiB e partes192KiB+SHA256; getContact renovado antes da identidade; vínculo nativo prioritário; recuperação/duplicidade independentes; enriquecimento existente e bloqueio de criação normal; progresso durável em preparação e verificação da fila.

Revisão independente: corrigidos contato não renovado, histórico longo na fila, recusa de crédito confundida com query_failed, lookup interno após fallback, inbox revalidado a cada tentativa e inconsistência de anexos perdida em retomada. Regressões específicas incluídas.

Verificação intermediária: 43/43 nos testes de confiabilidade/e2e após essas correções; 26/26 scripts; typecheck e dry-run PASS; verify:automation offline zero chamadas remotas. Suíte anterior completa:596 PASS/3FAIL, com as três falhas de campos personalizados reproduzidas no HEAD intacto (68PASS/3FAIL). Resultado final será registrado abaixo.

Resultado da entrega inicial: npm test -- --maxWorkers=1 →602PASS/3FAIL em605 testes; as três falhas de campos personalizados foram reproduzidas no HEAD intacto. Correção subsequente: as validações de ID e o mapeamento do payload foram corrigidos; 605/605 testes passaram, incluindo os 71 testes de regressão. Typecheck PASS.

Limites materiais: paginação de coleções condicional aos links reais; contratos reais e CDN não comprovados nesta sessão; CLI live continua sem integração ao orçamento remoto. Partes de arquivo revalidam conteúdo integral, com custo de releitura. Criação automática normal de Pessoa e merge de duplicatas bloqueados. Sem push, PR, deploy ou escrita CRM.

### Validação live e atualização — 2026-10-28

- Paginação real: conversas pages 1–3 retornaram 25 itens distintos por página, sem `next`/terminal; anexos da conversa 42 retornaram os mesmos 17 IDs em pages 1–2. Ambos permanecem corretamente declarados parciais.
- Redirect de anexo autorizado: `data_url` do Agendor Chat redirecionou para `agendor-chat-sa-production.s3.sa-east-1.amazonaws.com`. Foi incluído apenas o origin HTTPS exato na allowlist; os demais continuam recusados.
- Regressão: o caso RED falhou em `redirect_origin_not_allowed`; após a alteração, `test/chat-attachments.test.ts` passou 16/16.
- Deploy autorizado: Worker `elo-agendor-mcp`, versão `45325820-bd85-4545-805f-3ae124e288ac`, 100% no deployment. Pós-deploy, `chat_get_attachment` retornou `available`, áudio OGG completo de 25,408 bytes; o payload não foi exibido.
- Sem escrita CRM, alteração de secrets, ativação de política ou backlog de fila. Paginação final exaustiva continua sem metadados/contrato e por isso segue parcial.

### Validação adicional — 2026-11-01

- Leitura autenticada da coleção geral comprovou que `page` avança, mas sem links ou sinal terminal. Uma sequência de páginas 1–4 retornou 100 IDs únicos; outra execução encontrou registros nas páginas 5–8, enquanto uma nova varredura desde a página 1 encontrou páginas 5–9 vazias. Os resultados vazios não são estáveis e não podem encerrar cobertura.
- A rota por contato também foi inconsistente entre amostras/chamadas: página posterior repetiu um ID, e resultados observados não coincidiram de forma estável com a coleção geral. Nenhum metadata de continuação foi recebido.
- Ajuste TDD: o scanner registra `emptyPage` e continua pelos demais slots do lote; `nextPage` continua disponível após o limite. Cobertura não passa a completa sem sinal terminal upstream.
- Filtro de status: `page=1` sem status retornou somente `open`; `status=resolved` retornou resolvidas e `status=all` retornou mistura. O cliente agora pede `all` por padrão, preservando filtros explícitos.
- RED: o teste da página vazia seguida de registros falhou porque o scanner parava na página 2. O teste do filtro também falhou porque o status era omitido. GREEN: `npm run test:adapters` 30/30 e `npm run typecheck` PASS; `git diff --check` sem erros. `npm test -- --maxWorkers=1` não inicializou os testes: runtime local sem `cloudflare:test-internal`, mais erro de permissão de log do Wrangler em AppData. Sem deploy ou escrita CRM.

### Deploy e ativação controlada — 2026-11-03

- Worker `elo-agendor-mcp` implantado; versão `2b260b00-f1af-4d3e-a4e6-08141ce8db24` ativa a 100%. `GET /health` e `server_status` retornaram `ok`, versão `0.1.2`.
- `chat_list_conversations(page=1)` retornou 75 registros em 3 páginas (55 abertas e 20 resolvidas), mantendo `coverage.complete=false` e `stoppedBy=page_limit`; não declarar a coleção exaustiva.
- Política remota de automação ativada em `apply`, versão 5, para inboxes 4101 e 4102, com limites atuais de 2 conversas, 20 comandos e 20 requisições. Status confirmou 0 revisões e 0 operações pendentes.
- A criação nativa de Pessoa permanece bloqueada (`nativeCreatorDisabled=false`); mapeamentos de funil, etapa e campos personalizados permanecem vazios. Não foi feita nenhuma escrita CRM nesta publicação.
- `npm run test:adapters` (30/30), `npm run test:scripts` (26/26), `npm run typecheck`, `npm run verify:automation` offline (0 chamadas remotas) e `wrangler deploy --dry-run` passaram. A suíte completa não inicializou pelo runtime local `cloudflare:test-internal` e falha de permissão de log documentados acima.

### Correção de snapshot e verificação — 2026-11-03

- O usuário executou `npm test -- --maxWorkers=1`: 43 arquivos e 612/612 testes passaram. Os logs `REVIEW_SOURCE_CHANGED`, `IDEMPOTENCY_CONFLICT` e `REVIEW_ANALYSIS_CHANGED` correspondem a rejeições esperadas cobertas por testes negativos.
- Schema `attachmentListing` atualizado para aceitar `source` e `messagePagesRead`, e fixtures dos testes Chat ajustados para a sonda de páginas adicionais. Typecheck PASS.
- Deploy autorizado: versão `c53c5538-4cd5-4e09-af92-b6cfc39cb00f` ativa a 100%, mensagem `Fix Chat attachment snapshot schema`. Health e `server_status` retornaram `ok`; política remota continua `apply` v5; sem operações/revisões pendentes e sem escrita CRM.
