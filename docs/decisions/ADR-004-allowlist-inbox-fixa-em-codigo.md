# ADR-004: Allowlist de caixas de entrada fixa em código

- **Status:** Aceito
- **Data:** 2026-10-28 (endurecida em 2026-11-10)

## Contexto

A conta do Agendor Chat pode conter múltiplas caixas de entrada, mas somente as caixas comerciais definidas para cada implantação fazem parte do escopo autorizado da automação (por exemplo, `[4101, 4102]` em `test/wrangler.jsonc`). O endpoint de listagem de conversas do Chat não comprova filtro nativo isolado por caixa no servidor upstream, e uma política configurada dinamicamente sem limite rígido poderia expor inadvertidamente conversas de outras caixas.

## Decisão

Obter a allowlist autorizada de `allowedInboxIds` no define `__ELO_DEPLOYMENT__` do build. `src/app/config/deployment.ts` valida essa configuração fail-closed; `src/app/config/tenant.ts` a expõe como `ALLOWED_INBOX_IDS`, e `assertInboxAllowed` em `src/domain/inbox-policy.ts` verifica os IDs autorizados. A allowlist é imutável em tempo de execução, e a política persistida só pode restringi-la (`allowedInboxIds ∩ policy.allowedInboxIds`; lista vazia nega tudo, fail-closed). A restrição é verificada em todas as etapas críticas: inventário completo antes do discovery, detalhe canônico antes da preparação/retomada e revalidação antes e depois de cada dispatch na fila.

## Alternativas consideradas

- **Allowlist configurável apenas via variável de ambiente ou política no DO:** permitiria ampliação de escopo operacional sem revisão de código e testes.
- **Confiar apenas no `inboxId` salvo no snapshot inicial:** rejeitado porque conversas podem mudar de caixa entre preparo, retomada e entrega na fila.

## Consequências

- Expandir para uma nova caixa exige alteração deliberada de `allowedInboxIds` na configuração da implantação, novo build e deploy.
- Enquanto `GET /accounts/{account}/inboxes` não retornar exclusivamente o conjunto configurado em `allowedInboxIds` (por exemplo, `[4101, 4102]` em `test/wrangler.jsonc`), sem duplicatas ou paginação restante, o discovery falha fechado para proteger caixas externas.
- Esta regra é tratada como invariante de segurança do repositório.

## Revisão de 2026-11-19

Para permitir a publicação do código em repositório público sem expor identificadores específicos de uma implantação no código-fonte versionado, a allowlist de caixas de entrada foi movida do código para a configuração de implantação injetada no build via `__ELO_DEPLOYMENT__.allowedInboxIds` (validada em `src/app/config/deployment.ts` e exposta por `src/app/config/tenant.ts` e `src/domain/inbox-policy.ts`, usando valores como `[101, 102]` na configuração local de cada implantação).

- **Explícita e imutável em tempo de execução**: `DEPLOYMENT` e `allowedInboxIds` são congelados com `Object.freeze` na carga do módulo; a política persistida no Durable Object continua podendo apenas restringir esse conjunto (`allowedInboxIds ∩ policy.allowedInboxIds`).
- **Sem alteração por ferramentas MCP**: nenhuma ferramenta MCP lê parâmetros para ampliar a allowlist ou altera `__ELO_DEPLOYMENT__.allowedInboxIds` (`automation_update_policy` opera estritamente dentro do subconjunto já permitido no build).
- **Fail-closed na inicialização**: se `__ELO_DEPLOYMENT__` estiver ausente, contiver campos extras ou possuir `allowedInboxIds` vazio, duplicado ou inválido segundo o schema Zod, `parseDeployment` lança erro na carga do módulo e derruba o Worker imediatamente.
- **Mesmo processo de mudança**: ampliar a allowlist continua exigindo edição explícita da configuração de implantação (`wrangler.jsonc` local, fora do Git), novo build e deploy.
