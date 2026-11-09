# Elo Agendor Remote MCP

Worker TypeScript com OAuth e Streamable HTTP em `/mcp`. A versão candidata local **0.1.2** oferece **42 ferramentas** quando CRM e Chat estão configurados, preservando as 15 anteriores. Ela prepara conversas, contexto Markdown e catálogo para interpretação pelo agente MCP; submete análises e executa planos somente com política, evidência e escopos válidos. Não requer API ou segredo de IA.

Endpoint existente: [MCP](https://elo-agendor-mcp.example.workers.dev/mcp) e [saúde pública](https://elo-agendor-mcp.example.workers.dev/health). A ampliação local ainda **não foi publicada** neste rollout. A última publicação registrada, seus destinos e o gate de ativação estão em [deployment](docs/deployment.md). O [manifesto inicial](docs/rollout-pilot.json) mantém automação `disabled`, capacidades e alvos vazios; não autoriza chamadas remotas ou escrita.

Requer Node >=22.19.0. Execute `npm ci`, copie `.dev.vars.example` para `.dev.vars` e preencha os secrets apenas localmente. `npm run dev` inicia o runtime; no Windows, `npm run dev:ephemeral` contorna falhas locais de persistência SQLite. OAuth usa KV, e o estado da automação usa Durable Object SQLite. O modo ephemeral perde esse estado ao encerrar. [OAuth e Access](docs/oauth-setup.md) explicam a conexão dos clientes. Nunca inclua credenciais em URLs ou em `vars` do Wrangler.

O fluxo é `automation_prepare_sync` → ler mensagens/contexto e cobertura → interpretar → `automation_submit_analysis` → `automation_apply_plan` somente em apply delegado → `automation_get_operation` → conferir contexto. Preview termina antes de apply. GET/contexto não criam registros; submit grava estado interno e plano, sem escrever CRM. Automação desabilitada não bloqueia ferramentas diretas já autorizadas por seus próprios escopos.

As ferramentas CRM incluem leitura, catálogo, criação e enriquecimento tipados, além das quatro atualizações legadas. Criação exige `crm:create`, enriquecimento `crm:enrich`; `crm:write` antigo não concede esses poderes. As oito ferramentas Chat exigem `chat:read`, usam conta fixa e apenas leitura. O [inventário exato e matriz de permissões](docs/operations.md) explicam os 42 nomes e sua disponibilidade condicional.

Cobertura parcial do Chat, anexos indisponíveis, ambiguidades e semântica não comprovada permanecem pendências. Escrita de produtos/preços e substituição de coleções continuam bloqueadas. Sem comprovação da exclusividade do criador nativo e do vínculo conversa/caixa, mantenha preview. Não há declaração de automação comercial completa ou de piloto real concluído.

Atualização local de confiabilidade: [histórico, inboxes, identidade e anexos](docs/agendor-reliability.md). Apenas inboxes 4101/4102; cobertura de mensagens é calculada e o vínculo nativo tem prioridade. Paginação de coleções e CDN continuam condicionadas à evidência da API real.

Verificação offline: `npm test`, `npm run test:adapters`, `npm run test:scripts`, `npm run typecheck`, `npm run build` e `npm run verify:automation`. Build é dry-run. O verificador de automação não chama rede por padrão; leitura real e piloto exigem opções e alvos deliberados. Veja [operação](docs/operations.md), [fluxo do agente](docs/agent-workflow.md), [recuperação e piloto](docs/automation-operations.md) e [contratos e limites](docs/automation-contracts.md).

As dependências diretas são fixadas em `package.json`/`package-lock.json`: Agents 0.29.0 com SDK MCP 2.3.1, Inspector 2.11.0 e biblioteca OAuth 1.2.3. `src/version.ts` deriva a versão do pacote; a versão local não é um identificador de publicação Cloudflare.
