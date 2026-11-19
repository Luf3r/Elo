# Plano de refatoração e correção — 2026-11-17

Base: `main` em `9dedbfd` (0.1.7). Diagnóstico completo na seção 1; execução por fases na seção 3.

## Estado em 2026-11-19

| Fase | Estado | Resumo do entregue e do que falta |
|---|---|---|
| Fase 0 — Rede de segurança | **Concluída** | `0.2` a `0.7` concluídos; `0.1` concluído em 2026-11-19 com o remoto público [Luf3r/Elo](https://github.com/Luf3r/Elo), push de `main` e tag `v0.1.7`; CI obrigatório na proteção de `main` (`0.6`). |
| Fase 1 — Formatação e lint | **Concluída** | Prettier + ESLint type-aware integrados ao `npm run check`, commit de formatação com `.git-blame-ignore-revs` e correção das promises flutuantes. |
| Fase 2 — Documentação | **Concluída** | `npm run docs:tools` com teste de sincronia, `README.md` reescrito, documentação vigente em `docs/`, `CHANGELOG.md`, `AGENTS.md` e organização histórica em `docs/history/`. |
| Fase 3 — Reestruturação | **Concluída** | Testes de caracterização, `src/agendor/ports.ts`, `src/domain/` puro, repositórios por agregado em `src/automation/state/repositories/`, casos de uso em `src/automation/usecases/`, schemas separados, migrations declarativas, `readJson`, `src/app/config/tenant.ts` e regras de camada como erro no lint. |
| Fase 4 — Erros e observabilidade | **Parcial** | Concluídos `4.1` (`POLICY_BLOCKED`, `WORK_STALE`, `CONFLICT`, atualização de descrições/instruções MCP e ajuste definitivo do teste do P4, marcando quebra de compatibilidade para `0.2.0`) e `4.2` (`src/shared/logger.ts` e logs estruturados em entrada HTTP/MCP, fila e watchdog). **Falta**: `4.3` (avaliar Workers Logs/`invocation_logs` e configurar painel mínimo). |
| Fase 5 — Limpeza e segurança | **Concluída** | `5.1` (remoção de `MCP_TEST_TOKEN`), `5.2` (remoção de `/automation/chat-events`; rotas OAuth sem `CF-Connecting-IP` retornam `429`), `5.3` (revisão de segurança e `npm audit --omit=dev` no CI) e `5.4` (Dependabot para npm e GitHub Actions em `.github/dependabot.yml`). |
| Fase 6 — Testes | **Concluída** | Suíte unitária de `src/domain/` em Node (`npm run test:domain`), builders de fixture (`test/fixtures/builders.ts`), cobertura Istanbul com limiares em `src/domain/` e `src/automation/` (`npm run test:coverage`), testes de propriedade com `fast-check` (`test/domain/properties.test.ts`) e critérios de `npm run test:contract` documentados. |
| Fase 7 — Scripts e ferramentas | **Concluída** | Scripts migrados para TypeScript executado diretamente pelo Node (`scripts/*.ts`), helpers comuns extraídos em `scripts/lib/` e referência operacional documentada em `docs/operations/scripts.md`. |
| Fase 8 — Ambientes e rollout | **Adiada** | `8.1` e `8.2` (ambiente `staging` separado na Cloudflare/Access e deploy gradual) **adiados** por decisão do responsável. Entregue apenas `8.3` (runbook de rollback por versão em `docs/operations/deploy.md`). |

### Decisões da seção 5 (registradas como tomadas)

1. **Remoto (5.1)**: repositório **público** no GitHub, decidido em 2026-11-19, depois de limpar identificadores do código e do histórico e renomear o projeto para Elo (execução operacional de `0.1`, proteção de branch `0.6` e Dependabot `5.4` pendentes).
2. **Histórico (5.2)**: preservado em `docs/history/` (aplicado na Fase 2).
3. **Quebra de códigos de erro na Fase 4 (5.3)**: **aceita** — `POLICY_BLOCKED`, `WORK_STALE` e `CONFLICT` integrados; próximo release sai como `0.2.0`.
4. **Staging / Fase 8 (5.4)**: **adiado** — sem provisionamento de ambiente `staging` na Cloudflare/Access nesta rodada; apenas o runbook de rollback por versão (`8.3`) foi incluído.
5. **Endpoint `/automation/chat-events` (5.5 / item 5.2)**: **removido** (junto com `AUTOMATION_CHAT_HINTS_ENABLED`) até existir webhook assinado do Agendor.

## 0. Princípios

1. **Nenhuma mudança de comportamento escondida.** Cada commit é *ou* estrutural (mover, renomear, formatar, extrair) *ou* comportamental — nunca os dois. Commits estruturais não alteram nenhum teste existente.
2. **Verde em todo commit.** `npm run check` (criado na Fase 0) passa antes de cada commit; nada de `wip`.
3. **Uma fase = uma branch = um PR**, revisado e mesclado antes da próxima que depender dela.
4. **Sem deploy no meio de uma fase.** Produção só recebe versões taggeadas pelo fluxo de release (Fase 0.4).
5. **Segurança não regride.** Escopos, allowlist de inbox, fencing, idempotência e fail-closed são invariantes; qualquer teste que os cubra só muda com justificativa explícita no PR.

## 1. Diagnóstico

### 1.1 Processo e rastreabilidade

| # | Problema | Evidência |
|---|---|---|
| P1 | Sem remoto git; código de produção existe em uma única máquina | `git remote -v` vazio |
| P2 | Sem CI; nada impede deploy com testes vermelhos | ausência de pipeline |
| P3 | Deploys não correspondem a commits | 0.1.5, 0.1.6 e 0.1.7 publicadas em 10/11; só 2 commits desde 27/10, o último um `wip` de 1.322 linhas feito hoje |
| P4 | `main` vermelho | `test/automation-e2e.test.ts:185` espera `INVALID_INPUT`, recebe `MCP_UNAUTHORIZED` (determinístico) |
| P5 | Rejeição de promise não tratada durante a suíte | `uncaught exception … Preparation already running` (`repository.ts:347`) |
| P6 | Testes não são herméticos: carregam o `.dev.vars` real | `Using secrets defined in .dev.vars` na saída do vitest; `ACCESS_CLIENT_SECRET` real entra no worker de teste |
| P7 | Não há ambiente de staging; validação acontece direto em produção | `wrangler.jsonc` só tem um ambiente |

### 1.2 Documentação

| # | Problema | Evidência |
|---|---|---|
| D1 | Fatos contraditórios | ferramentas: README 42, `operations.md` 43, `agent-workflow.md` 45, código **44**; versão: README "0.1.2 não publicada", produção 0.1.7 |
| D2 | Estado atual misturado com histórico | `deployment.md` (168 linhas) empilha 6 publicações; vários docs abrem com "o abaixo é histórico" |
| D3 | Artefatos de execução de agentes tratados como documentação | `plan.md` (1.644 linhas, descreve servidor *read-only/stateless*), `implementation-progress.md`, `oauth-progress.md`, `superpowers/` |
| D4 | Dados de máquina pessoal no repositório | `cloudflare-agent-setup.md` (caminhos `C:\Users\…`, config do Codex) |
| D5 | Idioma misto | `automation-execution.md`, `automation-state.md` em inglês; resto em português |
| D6 | `rollout-pilot.json` desatualizado e enganoso | diz `disabled` / 0.1.2; política real está no Durable Object (preview v6) |
| D7 | Sem CHANGELOG nem tabela versão ↔ commit ↔ versão Cloudflare | IDs de versão espalhados em 4 arquivos |
| D8 | Sem documento de arquitetura; o README é um bloco de parágrafos | — |

### 1.3 Código

| # | Problema | Evidência |
|---|---|---|
| C1 | Legibilidade: linhas de até 887 caracteres, vários statements por linha | 361 linhas >200 col em `src/`; testes e scripts no mesmo estilo |
| C2 | Sem formatter/linter | nenhum config |
| C3 | Arquivos-deus | `repository.ts` 70 KB, `service.ts` 41 KB, `schemas.ts` 32 KB |
| C4 | Repositório executa regra de negócio | `repository.ts:512,527` chama `resolveCustomer`/`resolveDemands` dentro de `transactionSync` |
| C5 | Camadas invertidas: adaptadores Agendor importam o domínio de automação | `agendor/{chat,crm}` importam `automation/state/budget` e `automation/inbox-policy` |
| C6 | Taxonomia de erros ambígua | `INVALID_INPUT` usado com HTTP 409 (5×) para trabalho obsoleto; `MCP_UNAUTHORIZED` usado para escopo **e** para estado da política (causa do P4) |
| C7 | Erros engolidos sem log | `safeError()` converte tudo em `UPSTREAM_UNAVAILABLE`; `index.ts` tem `catch{}` sem log; só 1 `console.*` em `src/`; `invocation_logs: false` |
| C8 | 26 `JSON.parse(...) as T` sem validação de dados lidos do SQLite | `grep "JSON.parse(.*) as "` |
| C9 | Migrations imperativas e sem teste de upgrade | `if (!exists version N)` encadeados em `migrations.ts` |
| C10 | Código morto do token fixo "aposentado" | `MCP_TEST_TOKEN` em `env.ts`, `setup-local-token.mjs`, `verify-oauth.mjs`, `stage-oauth-secret.mjs`, helpers de teste |
| C11 | Endpoint não assinado `/automation/chat-events` desligado, mas mantido | `ingress.ts` + flag `AUTOMATION_CHAT_HINTS_ENABLED` |
| C12 | Configuração de tenant espalhada | inboxes `4101/4102` em código, conta `'elotenant'`, account `7001` em `wrangler.jsonc` |
| C13 | Gate de orçamento serializa *todas* as chamadas Agendor por um único DO (4 req/10 s por produto), inclusive leituras diretas | `state/budget.ts` — decisão não documentada |
| C14 | 12 scripts `.mjs` densos, com lógica duplicada (redação de segredos, sessão OAuth) | `scripts/` |

## 2. Estado-alvo

```
src/
  app/          index.ts (roteamento), env.ts, config/tenant.ts
  shared/       errors, http, cancellation, logger, digest, json (readJson com schema)
  oauth/        (inalterado na estrutura)
  agendor/      ports.ts (BudgetGate, InboxGuard) + chat/ + crm/  — sem imports de automation/
  domain/       identity, demands, planner, fields, stages, policy, authorization  — puro, sem IO
  automation/
    usecases/   preflight, discover, prepare, submit, apply, reviews, reprocess, audit, context
    state/      account.ts (DO), migrations/, repositories/{work,plans,commands,reviews,context,customers,audit,budget}.ts
    execution/  executor, queue, reconciliation, verification-reader, maintenance
  mcp/          server, result, security, tools/
docs/
  README.md (índice)  architecture.md  security.md  tools.md (gerado)
  operations/{deploy,rotation,recovery,pilot}.md
  integrations/{agendor-chat,agendor-crm}.md
  decisions/ADR-NNN-*.md
  history/      (tudo que é registro datado)
CHANGELOG.md  AGENTS.md (ou CLAUDE.md)
```

Regras de dependência (verificadas por lint): `domain` não importa nada de IO; `agendor` não importa `automation`/`domain`; `mcp` só fala com `usecases`.

## 3. Fases

Tamanho: **P** ≈ meio dia, **M** ≈ 1–2 dias, **G** ≈ 3–5 dias.

### Fase 0 — Rede de segurança (P–M) · bloqueia todas

0.1 **Remoto privado** (GitHub) e push de `main`; tag `v0.1.7` em `9dedbfd` marcando o que está em produção (confirmar com `server_status`).
0.2 **Corrigir P4**: ajustar a expectativa do teste para o comportamento atual (rejeição por política, fail-closed). O código definitivo vem na Fase 4.
0.3 **Corrigir P5**: localizar a promise sem `await`/`catch` no teste de concorrência de preparação e tratá-la; a suíte deve terminar sem `uncaught exception`.
0.4 **Testes herméticos (P6)**: config de teste que não carrega `.dev.vars` (wrangler de teste dedicado ou caminho de vars vazio). Critério: a suíte passa com `.dev.vars` renomeado.
0.5 **`npm run check`**: typecheck + `test` + `test:adapters` + `test:scripts` + `build`.
0.6 **CI** (GitHub Actions): `npm ci`, `npm run check`, `npm audit --omit=dev`, em todo push/PR; proteção de branch em `main`.
0.7 **Release rastreável**: script `release` que exige árvore limpa, `check` verde e tag; publica com a mensagem/tag de versão do Wrangler contendo o hash do commit; `/health` e `server_status` passam a expor `commit` (injetado no build via `define`).

**Aceite:** CI verde no `main`; o próximo deploy é reproduzível a partir de uma tag.

### Fase 1 — Formatação e lint (M) · depois da 0, antes da 3

1.1 Prettier (formatação) + ESLint com `typescript-eslint` type-aware. Regras-chave: `no-floating-promises` (pega a classe do P5), `no-misused-promises`, `no-unsafe-*`, `max-statements-per-line: 1`, `max-lines` (aviso, 400), `import/no-restricted-paths` (para as regras de camada da seção 2, de início só aviso).
1.2 Um único commit `style: apply prettier` em `src/`, `test/` e `scripts/`, registrado em `.git-blame-ignore-revs`.
1.3 Corrigir os erros de lint que forem bugs reais (promises flutuantes) em commits separados; os demais vão para uma baseline.
1.4 `lint` e `format:check` entram no `check`.

**Aceite:** zero linhas >120 colunas fora de strings/SQL; CI falha em promise flutuante.

### Fase 2 — Documentação (M) · paralelizável com a Fase 1

2.1 **Inventário gerado**: script `docs:tools` cria `docs/tools.md` a partir do `tools/list` real (nome, escopos, condição de disponibilidade, read/write). Um teste falha se o arquivo divergir — acaba com o D1 de forma permanente.
2.2 **README** reescrito em seções: o que é, estado atual (versão, modo, link do CHANGELOG), início rápido, verificação, mapa de docs.
2.3 **`architecture.md`**: camadas, fluxo preflight→discover→prepare→submit→apply, DO, fila/DLQ, cron/watchdog, gate de orçamento (C13), diagrama.
2.4 **`security.md`**: modelo de ameaça, matriz de escopos, allowlist de inbox, fencing/idempotência, o que é tratado como evidência não confiável.
2.5 **`operations/`**: deploy (usa o release da 0.7), rotação de segredos, recuperação/DLQ, piloto. Só procedimento vigente.
2.6 **ADRs** extraídos das specs e "rulings": OAuth via Access, DO único por conta, Chat somente leitura, allowlist fixa em código, budget compartilhado, criador nativo de pessoa.
2.7 **CHANGELOG.md** reconstruído de 0.1.0 a 0.1.7 + tabela versão ↔ commit ↔ ID Cloudflare ↔ data.
2.8 **`docs/history/`**: mover `plan.md`, `*-progress.md`, `superpowers/`, `zapia-*`, partes históricas de `deployment.md`/`agendor-chat-api.md`/`automation-contracts.md`, com um índice. Remover `cloudflare-agent-setup.md` (D4) e `rollout-pilot.json` (D6), ou substituí-los pela leitura de `automation_get_status`.
2.9 Tudo em português; identificadores de código em inglês.
2.10 **`AGENTS.md`** com as convenções para agentes: rodar `check`, não commitar `wip`, separar commits estruturais e comportamentais, atualizar CHANGELOG e docs no mesmo PR, onde ficam os registros de execução (fora de `docs/`).

**Aceite:** nenhum número ou versão escrito à mão diverge do código; um leitor novo chega ao estado atual só pelo README.

### Fase 3 — Reestruturação (G) · depois da 1; puramente estrutural

3.0 **Testes de caracterização antes de mover**:
   - migrations: banco vazio → versão atual, e cada versão anterior → atual, com dados de fixture;
   - snapshot das respostas dos casos de uso principais (prepare/submit/apply) nos cenários do e2e.
3.1 **Ports dos adaptadores (C5)**: `agendor/ports.ts` define `BudgetGate` e `InboxGuard`; a implementação fica em `automation/`, injetada por quem cria o cliente.
3.2 **`domain/`**: mover identity, demands, planner, fields, stages, policy, authorization; sem `env`, sem DO, sem `fetch`.
3.3 **Dividir `repository.ts` (C3, C4)** por agregado. Atomicidade: o caso de uso calcula a decisão com funções puras do domínio e entrega ao repositório uma função pura a rodar dentro do `transactionSync`, recebendo os dados lidos na própria transação. O repositório deixa de importar `identity`/`demands`/`render`.
3.4 **Dividir `service.ts`** em `usecases/*`, com um `WorkflowContext` compartilhado (env, auth, signal, repository, policy).
3.5 **Dividir `schemas.ts`** por contexto, ao lado dos tipos (`types.ts` já usa `z.infer`; manter).
3.6 **Migrations declarativas (C9)**: lista `[{ version, up }]` com runner transacional; schema final idêntico (verificado pelo teste 3.0).
3.7 **`readJson(schema, text)` (C8)** no lugar dos 26 `JSON.parse as`; linha corrompida vira erro explícito e logado, não um objeto mal tipado.
3.8 **Config de tenant (C12)** centralizada em `app/config/tenant.ts`; a allowlist continua em código (é decisão de segurança, ADR 2.6).
3.9 Regras de camada do lint passam de aviso a erro.

**Aceite:** nenhum teste pré-existente alterado; snapshots 3.0 idênticos; nenhum arquivo de `src/` acima de ~400 linhas.

### Fase 4 — Erros e observabilidade (M) · depois da 3; **muda comportamento → 0.2.0**

4.1 **Taxonomia (C6)**: `MCP_UNAUTHORIZED` só para identidade/escopo; novo `POLICY_BLOCKED` (modo/versão da política); `WORK_STALE`/`CONFLICT` 409 no lugar de `INVALID_INPUT`+409. Atualizar as descrições das ferramentas e as instruções do servidor; registrar no CHANGELOG como quebra para os clientes (ChatGPT, Zapia). Ajustar de forma definitiva o teste do P4.
4.2 **Logger estruturado** em `shared/logger` (JSON; campos `event`, `requestId`, `operationId`, `code`; redação de tokens e PII). Logar todo erro desconhecido antes do `safeError`, o `catch` do `index.ts`, falhas de fila, envios à DLQ e o watchdog.
4.3 Avaliar Workers Logs/`invocation_logs` e um painel mínimo (erros por código, DLQ, budget negado).

**Aceite:** todo 5xx gera um log com causa; um erro de política é distinguível de um erro de permissão pelo código.

### Fase 5 — Limpeza e segurança (M) · depois da 3

5.1 **Remover `MCP_TEST_TOKEN` (C10)**: env, scripts, helpers, docs.
5.2 **`/automation/chat-events` (C11)**: decidir entre remover ou implementar assinatura verificável. Recomendação: remover até existir webhook assinado do Agendor.
5.3 Revisão de segurança dedicada (`/security-review`) sobre o branch refatorado: OAuth/consent, rate limit (chave `unknown` sem `CF-Connecting-IP`), limites de tamanho, redação em logs.
5.4 Dependabot/Renovate no remoto; `npm audit` no CI (já na 0.6).

### Fase 6 — Testes (M, contínua)

6.1 Pirâmide: testes de `domain/` em ambiente Node (rápidos); integração com o pool do Workers; e2e MCP só para os fluxos centrais.
6.2 Builders de fixture no lugar de objetos literais repetidos; testes formatados e legíveis.
6.3 Cobertura (istanbul) com limite mínimo para `domain/` e `automation/` no CI.
6.4 Testes de propriedade (fast-check) para normalização de telefone/CNPJ/e-mail e idempotência de `requestId`.
6.5 Testes de contrato (`test:contract`): documentar quando rodar; opcionalmente um job manual no CI com segredos de staging.

### Fase 7 — Scripts e ferramentas (P–M)

7.1 Converter `scripts/*.mjs` para TypeScript executado direto pelo Node (*type stripping*, disponível na linha 22.18+; confirmar na 22.19), com tipagem e lint.
7.2 Extrair helpers comuns (redação de segredos, sessão OAuth, cliente MCP).
7.3 Agrupar os npm scripts (`check`, `verify:*`, `oauth:*`, `release`) e documentá-los em `operations/`.

### Fase 8 — Ambientes e rollout (M) · depois da 0; exige decisão e custo

8.1 Ambiente `staging` no Wrangler com KV, DO, fila/DLQ e rate limiters próprios, além de um Access app separado.
8.2 Deploy em etapas: `wrangler versions upload` → smoke em staging/preview → `versions deploy` gradual em produção.
8.3 Runbook de rollback por versão.

## 4. Ordem e paralelismo

```
F0 ──► F1 ──► F3 ──► F4 ──► release 0.2.0
 │      └─ F2 (paralela a F1/F3; 2.1 depende só de F0)
 ├─► F8 (independente, após decisão)
 └─► F6/F7 (contínuas; 6.1–6.3 se apoiam na F3)
F5 após F3 (5.1 pode ir já na F1)
```

Os releases intermediários (0.1.8…) saem só de tags, sem mudança de comportamento até a F4.

## 5. Decisões pendentes do responsável

1. Remoto: GitHub privado? (bloqueia 0.1/0.6)
2. Histórico em `docs/history/` ou apagar, confiando no git?
3. Aceitar a quebra de códigos de erro (F4) para os clientes atuais?
4. Criar staging (F8), com recursos Cloudflare e Access adicionais?
5. Endpoint de hints (5.2): remover ou implementar assinatura?

## 6. Pronto quando

- CI verde e obrigatório; todo deploy sai de uma tag e é rastreável até o commit.
- README, `tools.md` e CHANGELOG batem com o código por construção.
- Nenhum arquivo de `src/` passa de ~400 linhas; camadas verificadas por lint.
- Todo erro inesperado é logado; os códigos de erro distinguem permissão, política e conflito.
- Suíte hermética, sem rejeições não tratadas, com cobertura mínima no domínio.
