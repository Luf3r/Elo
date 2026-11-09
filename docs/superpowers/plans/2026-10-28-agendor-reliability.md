# Agendor Reliability Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans task by task.

**Goal:** Implementar o desenho aprovado para cobertura confiável e identidade canônica.
**Architecture:** Adaptadores paginados alimentam snapshots duráveis. Política de inbox é compartilhada em descoberta, preparação e execução. Downloads ficam isolados e limitados.
**Tech Stack:** TypeScript, Zod, Workers, Vitest, MCP SDK.
**Spec:** docs/superpowers/specs/2026-10-28-agendor-reliability-design.md

## Global Constraints

Somente inboxes 4101 e 4102. Nenhum deploy/escrita CRM. 20 MiB por arquivo, três redirects, HTTPS e hosts comprovados. Manter orçamento compartilhado. Preservar snapshots antigos sem declarar cobertura retroativa.

## Review Focus

- Inbox alterado durante retomada: bloquear antes de dispatch.
- Página cheia no fim: confirmar com página seguinte.
- Budget esgotado depois de páginas válidas: preservar progresso.
- 404 versus falha transitória: não criar Pessoa por erro.
- Base64 maior que limite MCP: disponibilizar partes verificáveis.

## Tasks

1. Runtime e política: adicionar testes isolados Node para adaptadores, diagnosticar runtime Cloudflare; criar inbox-policy.ts com allowedInboxIds/isInboxAllowed/assertInboxAllowed e usar antes de conteúdo em service/queue. Testar lista vazia, inbox ausente e mudança durante execução.
2. Mensagens e retomada: estender Coverage/MessagePage e schemas; listMessages(id,{after}) usa after=1 por padrão e next pelo último ID. createConversationReader preserva progresso ao adiar e service acumula snapshots. Testar 437, múltiplo de 100, repetição, ordenação, cursor posterior e budget.
3. Identidade: ler vínculo direto antes de candidates; adicionar crmContactLink/candidateRead/duplicateCheck em customerCandidatesSchema. Vínculo direto prevalece em resolveCustomer. Missing/stale permitem recuperação exata; query_failed bloqueia criação. Testar 404/timeout, ambiguidade, telefone/e-mail/CPF e nome fraco. Bloquear criação normal de Pessoa proveniente Chat.
4. Descoberta: conferir contratos reais/documentais e preservar metadados; adicionar page/cursor somente com evidência, filtrar inbox/deduplicar e retornar cobertura específica. Contato por GET individual. Reconciliar anexos de mensagens sem alegar completude de coleções parciais. Testar 1000+ IDs e ausência de contrato.
5. Anexos: observar hosts reais via GETs autorizados; validar cada salto e egress, MIME/tamanho, implementar representação correta e entrega em partes autenticadas. Testar hosts/IPs, 4 saltos, tamanho, MIME, cancelamento, PDF/áudio e limites MCP.
6. Regressão/documentação/revisão: atualizar fixtures/descrições/scripts/docs; executar npm test, test:scripts, typecheck, build e verify:automation; revisão independente final e correções.

Cada tarefa: escrever teste → observar falha esperada → implementar → verificar. Execução inline conforme aprovação de implementação; evitar outra aprovação para escolhas rotineiras. Histórico e decisões em docs/implementation-progress.md.

## Resultado de execução

- Tarefas1–3: implementadas e verificadas (política, retomada, identidade/recuperação/duplicidade).
- Tarefa4: adaptador implementado com continuação por links explícitos e limites específicos. Paginação real do Chat ainda não comprovada; não foi declarada verificada.
- Tarefa5: downloader/partes implementados e testados; apenas origem Chat permitida. Identificação/validação real de CDN ainda pendente.
- Tarefa6: documentação, verificação e revisão concluídas para as mudanças locais. Suíte602PASS/3FAIL preexistentes; adaptadores25PASS, scripts26PASS, tipos/build/verificadorPASS. Sem publicação.
