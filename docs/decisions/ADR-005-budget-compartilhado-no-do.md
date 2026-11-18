# ADR-005: Gate de orçamento compartilhado no Durable Object

- **Status:** Aceito
- **Data:** 2026-10-26

## Contexto

Rate limiters nativos da Cloudflare por edge/POP são aproximados por localização e não coordenam com precisão chamadas simultâneas vindas de requisições MCP interativas, etapas de preparação, downloads de anexos e entregas assíncronas da fila contra a mesma credencial Agendor. Sem coordenação global única, rajadas poderiam causar `429` recorrentes e degradação da conta.

## Decisão

Implementar um gate único de orçamento compartilhado (`takeBudget` em `AutomationAccount`) que serializa **todas** as chamadas reais à API do Agendor — inclusive leituras MCP diretas — limitando cada produto (`crm` e `chat`) a **4 reservas por janela móvel de 10.000 ms**, com relógio monotônico (`budget_clock`), sem reembolso após cancelamento e com falha fechada (`503`) caso o coordenador esteja indisponível.

## Alternativas consideradas

- **Rate limiters nativos do Wrangler (`1002`/`1004`) por POP:** aproximados por datacenter e incapazes de coordenar fila e chamadas diretas globalmente.
- **Delay fixo local (ex.: 350 ms) ou isenção para leituras diretas:** não coordena tráfego concorrente entre múltiplas requisições e permitiria que leituras diretas esgotassem a cota usada pela fila e reconciliação.

## Consequências

- Proteção determinística contra rajadas upstream e contabilização conjunta entre MCP direto, preparação e fila.
- **Trade-off registrado (C13):** todas as chamadas Agendor — inclusive leituras diretas — passam pelo singleton do DO `elotenant`, limitando a vazão global a 4 req/10s por produto e exigindo transporte conectado ao DO para qualquer CLI live (`discover:automation-contracts -- --live` permanece bloqueado offline até usar esse gate).
