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

## Revisão de 2026-11-19

Para permitir a publicação do código em repositório público sem expor identificadores específicos de uma implantação no código-fonte versionado, a allowlist de caixas de entrada foi movida do código para a configuração de implantação injetada no build via `__ELO_DEPLOYMENT__.allowedInboxIds` (validada em `src/app/config/deployment.ts` e exposta por `src/app/config/tenant.ts` e `src/domain/inbox-policy.ts`, usando valores como `[101, 102]` na configuração local de cada implantação).

- **Explícita e imutável em tempo de execução**: `DEPLOYMENT` e `allowedInboxIds` são congelados com `Object.freeze` na carga do módulo; a política persistida no Durable Object continua podendo apenas restringir esse conjunto (`allowedInboxIds ∩ policy.allowedInboxIds`).
- **Sem alteração por ferramentas MCP**: nenhuma ferramenta MCP lê parâmetros para ampliar a allowlist ou altera `__ELO_DEPLOYMENT__.allowedInboxIds` (`automation_update_policy` opera estritamente dentro do subconjunto já permitido no build).
- **Fail-closed na inicialização**: se `__ELO_DEPLOYMENT__` estiver ausente, contiver campos extras ou possuir `allowedInboxIds` vazio, duplicado ou inválido segundo o schema Zod, `parseDeployment` lança erro na carga do módulo e derruba o Worker imediatamente.
- **Mesmo processo de mudança**: ampliar a allowlist continua exigindo edição explícita da configuração de implantação (`wrangler.jsonc` local, fora do Git), novo build e deploy.
