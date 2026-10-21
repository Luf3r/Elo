# SDD ledger — plan: docs/plan.md

Execução inline. Pasta inicialmente vazia, sem repositório, código ou credenciais.

Pre-flight interfaces: 1→2 Wrangler/Env; 2→3 SafeError/Env; 2→4 fetchJson; 3+4→5 auth/client/server factory; 4+5→6 schemas/tools; 1→7 Chat gate; 4→8 real contracts; 5+6→9 Inspector; 1–9→10 deploy. Interfaces compatíveis com as decisões abaixo.

Ruling: workspace novo implementado no diretório solicitado, sem worktree adicional — não havia checkout ou alterações para isolar; custo: nenhum isolamento de branch preexistente necessário.
Ruling: scripts bash da skill não executam neste sandbox Windows (NtCreateDirectoryObject access denied); ledger e evidências mantidos aqui via PowerShell — custo: bookkeeping manual.
Ruling: Agents 0.29.0 exige SDK 2.3.1, usado conforme instrução oficial de respeitar os peers exatos — custo: sintaxe do SDK atual será validada por testes.
Ruling: segundo binding nativo CRM 4/10s necessário, pois 30 requisições MCP/10s permite rajadas e não limita chamadas individuais de ferramentas; limites nativos são aproximados por localização — custo: throughput reduzido e ausência de garantia global estrita sem coordenação fora do escopo.

Ruling: pool Workers 0.23 descontinuado e runtime limitado a 2026-08-22; substituído pelo sucessor oficial vitest-plugin 1.4.6, que suporta a data do projeto — custo: import de testes atualizado.
Ruling: Inspector 2.10.1 inclui SDKs com alertas de segurança; atualizado a 2.11.0 e audit limpo — custo: versão diferente da sugestão, permitido pela verificação da Task 1.

- Task 1: em andamento.
- Tasks 2–6: pendentes.
- Task 7: gate BLOCKED, falta contrato técnico Chat.
- Tasks 8–9: pendentes; chamadas reais dependem de credenciais.
- Task 10: pendente; usuário confirmou credenciais ainda não configuradas.
