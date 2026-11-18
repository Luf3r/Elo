# ADR-002: Durable Object único por conta lógica (`AutomationAccount`)

- **Status:** Aceito
- **Data:** 2026-10-26

## Contexto

A automação Chat → CRM coordena leases de trabalho com fencing, idempotência por `requestId`, contexto Markdown versionado por cliente, políticas de execução, revisões humanas, ledger de comandos recuperável e controle de orçamento compartilhado. O KV do OAuth possui consistência eventual e não fornece transações ACID nem serialização de concorrência.

## Decisão

Centralizar todo o estado transacional e a coordenação da conta em um único Durable Object SQLite (`AutomationAccount`), endereçado exclusivamente pelo servidor via `env.AUTOMATION_STATE.getByName('elotenant')`, com migrations incrementais em `schema_migrations` e blocos curtos de `transactionSync`.

## Alternativas consideradas

- **Armazenar estado de automação em KV:** inviável para fencing monotônico, idempotência transacional, orçamento móvel ou prevenção de criação duplicada entre conversas concorrentes.
- **Múltiplos Durable Objects por conversa:** impediria deduplicação entre conversas do mesmo cliente, compartilhamento de contexto por cliente e orçamento único por credencial Agendor.

## Consequências

- Serialização forte e garantida para leases, `requestId`, vínculos de cliente, política e orçamento compartilhado da conta `elotenant`.
- Chamadores HTTP nunca podem selecionar outra instância ou conta.
- A conta lógica única torna o DO um ponto central de serialização (mitigado mantendo hashing e chamadas HTTP fora dos blocos `transactionSync`).
