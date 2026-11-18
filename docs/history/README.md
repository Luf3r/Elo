# Arquivo Histórico (`docs/history/`)

Esta pasta preserva documentos datados, planos de implementação anteriores, especificações iniciais e relatórios operacionais pontuais cujo conteúdo vigente foi consolidado na documentação atual em `docs/`. **Estes arquivos não representam necessariamente o estado atual do código** — consulte [docs/README.md](../README.md) para a documentação vigente.

## Planos, progresso e registros de sessões

- [plan.md](plan.md) — Plano inicial do servidor MCP read-only/stateless.
- [implementation-progress.md](implementation-progress.md) — Diário histórico de execução das tarefas iniciais e confiabilidade Chat → CRM.
- [oauth-progress.md](oauth-progress.md) — Diário histórico da implementação OAuth 2.1 com Cloudflare Access.
- [rollout-pilot.json](rollout-pilot.json) — Artefato histórico inicial (`0.1.2`, `disabled`) substituído pela leitura em tempo real via `automation_get_status`.
- `superpowers/` — Especificações (`specs/`) e planos (`plans/`) originais datados entre 2026-10-21 e 2026-11-06.

## Relatórios Zapia e T01

- [zapia-fase-b.md](zapia-fase-b.md) — Relatório de segurança e validação da Fase B no Zapia.
- [zapia-t01.md](zapia-t01.md) — Contrato e histórico de publicação da T01 (versões `0.1.4` a `0.1.6`).
- [zapia-t01-design.md](zapia-t01-design.md) — Notas de desenho incremental da descoberta T01.
- [zapia-preparacao-deferred.md](zapia-preparacao-deferred.md) — Investigação de adiamentos repetidos e correção publicada na `0.1.7`.

## Documentos absorvidos pela documentação vigente

- [deployment.md](deployment.md) — Absorvido por [CHANGELOG.md](../../CHANGELOG.md) e [operations/deploy.md](../operations/deploy.md).
- [operations.md](operations.md) — Absorvido por [tools.md](../tools.md), [security.md](../security.md) e [operations/](../operations/deploy.md).
- [automation-operations.md](automation-operations.md) — Absorvido por [operations/recovery.md](../operations/recovery.md) e [operations/pilot.md](../operations/pilot.md).
- [oauth-setup.md](oauth-setup.md) — Absorvido por [security.md](../security.md) e [operations/rotation.md](../operations/rotation.md).
- [agent-workflow.md](agent-workflow.md) — Absorvido por [architecture.md](../architecture.md).
- [automation-execution.md](automation-execution.md) — Absorvido por [architecture.md](../architecture.md) e [operations/recovery.md](../operations/recovery.md).
- [automation-state.md](automation-state.md) — Absorvido por [architecture.md](../architecture.md) e [security.md](../security.md).
- [agendor-chat-api.md](agendor-chat-api.md) — Absorvido por [integrations/agendor-chat.md](../integrations/agendor-chat.md).
- [agendor-reliability.md](agendor-reliability.md) — Absorvido por [integrations/agendor-chat.md](../integrations/agendor-chat.md) e [security.md](../security.md).
- [automation-contracts.md](automation-contracts.md) — Absorvido por [integrations/agendor-chat.md](../integrations/agendor-chat.md) e [integrations/agendor-crm.md](../integrations/agendor-crm.md).
- [crm-write-api.md](crm-write-api.md) — Absorvido por [integrations/agendor-crm.md](../integrations/agendor-crm.md).
