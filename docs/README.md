# Índice da Documentação

Documentação vigente do projeto `elo-agendor-mcp`. Para o inventário atualizado do projeto e mapa de código, veja também o [README principal](../README.md).

## Documentos principais

- [tools.md](tools.md) — Inventário de ferramentas MCP gerado automaticamente por `npm run docs:tools` a partir do `tools/list` real do servidor.
- [architecture.md](architecture.md) — Arquitetura em camadas, fluxo da automação, Durable Object `AutomationAccount`, fila/DLQ, cron/watchdog e gate de orçamento único.
- [security.md](security.md) — Modelo de ameaça, OAuth/Access, matriz de escopos, allowlist de inbox, fencing/idempotência e tratamento de evidência não confiável.
- [plano-refatoracao.md](plano-refatoracao.md) — Plano de refatoração e correção do repositório.

## Operação

- [operations/deploy.md](operations/deploy.md) — Recursos Cloudflare, build rastreável e procedimento vigente de release/deploy.
- [operations/rotation.md](operations/rotation.md) — Rotação de segredos e revogação/renovação OAuth.
- [operations/recovery.md](operations/recovery.md) — Pausa da automação, reconciliação, DLQ, revisões, retenção e rollback.
- [operations/pilot.md](operations/pilot.md) — Verificação controlada e requisitos do piloto supervisionado.

## Integrações e templates

- [integrations/agendor-crm.md](integrations/agendor-crm.md) — Contratos, paginação, catálogo e limites de escrita no Agendor CRM V3.
- [integrations/agendor-chat.md](integrations/agendor-chat.md) — Contratos, paginação, cobertura parcial e anexos no Agendor Chat V1.
- [templates/cliente-contexto.md](templates/cliente-contexto.md) — Modelo estruturado do resumo Markdown por cliente (limite de 32 KiB).

## Decisões arquiteturais (ADRs)

- [decisions/README.md](decisions/README.md) — Índice de todos os ADRs vigentes.

## Arquivo histórico

- [history/README.md](history/README.md) — Documentos datados, specs originais e relatórios de sessões anteriores (somente referência histórica).
