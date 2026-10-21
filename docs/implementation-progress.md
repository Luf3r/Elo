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
- Task 10: login concluído e envio/publicação explicitamente autorizados; Cloudflare bloqueia criação do Worker com erro10034 até verificar o e-mail da conta. Nenhum secret cadastrado.

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
