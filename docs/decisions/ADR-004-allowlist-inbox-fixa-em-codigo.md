# ADR-004: Allowlist de caixas de entrada fixa em código

- **Status:** Aceito
- **Data:** 2026-10-28 (endurecida em 2026-11-10)

## Contexto

A conta do Agendor Chat pode conter múltiplas caixas de entrada, mas apenas duas caixas comerciais específicas (`4101` e `4102`) fazem parte do escopo autorizado da automação. O endpoint de listagem de conversas do Chat não comprova filtro nativo isolado por caixa no servidor upstream, e uma política configurada dinamicamente sem limite rígido poderia expor inadvertidamente conversas de outras caixas.

## Decisão

Fixar a allowlist autorizada em código (`allowedInboxIds = Object.freeze([4101, 4102])` em `src/automation/inbox-policy.ts`) e exigir interseção com `policy.allowedInboxIds` (lista vazia nega tudo, fail-closed). A restrição é verificada em todas as etapas críticas: inventário completo antes do discovery, detalhe canônico antes da preparação/retomada e revalidação antes e depois de cada dispatch na fila.

## Alternativas consideradas

- **Allowlist configurável apenas via variável de ambiente ou política no DO:** permitiria ampliação de escopo operacional sem revisão de código e testes.
- **Confiar apenas no `inboxId` salvo no snapshot inicial:** rejeitado porque conversas podem mudar de caixa entre preparo, retomada e entrega na fila.

## Consequências

- Expandir para uma nova caixa exige alteração deliberada de código, revisão e deploy.
- Enquanto `GET /accounts/{account}/inboxes` não retornar exclusivamente `4101` e `4102` sem duplicatas ou paginação restante, o discovery falha fechado para proteger caixas externas.
- Esta regra é tratada como invariante de segurança do repositório.
