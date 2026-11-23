# Elo Agendor Remote MCP

Worker TypeScript executado na Cloudflare Workers que expõe um servidor MCP remoto via Streamable HTTP (`/mcp`) autenticado por OAuth 2.1 (Cloudflare Access OIDC). Integra Agendor CRM V3 e Agendor Chat V1 com estado durável em Durable Object SQLite (`AutomationAccount`), fila de execução (`AUTOMATION_QUEUE`) e gate de orçamento compartilhado. O agente conectado ao MCP interpreta conversas e envia análises estruturadas; o servidor coordena identidade, catálogo, políticas, fencing e execução recuperável no CRM sem depender de API ou segredo de IA.

## Estado atual

- **Versão do pacote:** `0.2.1` (fonte única em [package.json](package.json) / [src/version.ts](src/version.ts)) — veja o histórico completo e a tabela de versões Cloudflare em [CHANGELOG.md](CHANGELOG.md).
- **Política de automação:** armazenada e versionada no Durable Object `AutomationAccount` (consulte o modo e a versão vigentes em tempo de execução pela ferramenta `automation_get_status`; não existe manifesto estático de modo).
- **Catálogo de ferramentas:** gerado diretamente a partir de `tools/list` do servidor em [docs/tools.md](docs/tools.md) (mantido em sincronia por teste automatizado).

## Início rápido

Requer **Node `>=22.19.0`**.

1. Instale as dependências:

   ```bash
   npm ci
   ```

2. Copie `.dev.vars.example` para `.dev.vars` e preencha apenas localmente `AGENDOR_CRM_TOKEN`, `ACCESS_CLIENT_SECRET` e, para Chat/automação, `AGENDOR_CHAT_TOKEN`. Nunca grave segredos em URLs, argumentos de CLI, logs ou arquivos versionados.
3. Inicie o servidor em desenvolvimento local:

   ```bash
   npm run dev
   ```

   No Windows, `npm run dev:ephemeral` contorna falhas locais de persistência SQLite usando armazenamento temporário (OAuth KV e estado do Durable Object são descartados ao encerrar).

Endpoints expostos pelo Worker:

- `GET /health`: liveness público que retorna `status`, `service`, `version` e `commit` sem consultar o Agendor.
- `POST /mcp`: endpoint MCP Streamable HTTP autenticado via OAuth 2.1 (escopos verificados por ferramenta e no autorizador).

## Verificação

Execute a suíte offline completa antes de qualquer commit ou PR:

```bash
npm run check
```

O comando `npm run check` executa em sequência:

1. `npm run format:check` (Prettier em `src/`, `test/` e `scripts/`)
2. `npm run lint` (ESLint com checagem de tipos e fronteiras)
3. `npm run typecheck` (`tsc --noEmit`)
4. `npm run test:domain` (testes puros do domínio em Node)
5. `npm run test:adapters` (testes unitários de adaptadores em Node)
6. `npm run test:scripts` (testes dos scripts em `scripts/`, incluindo a sincronia de [docs/tools.md](docs/tools.md) e deste README com `package.json`)
7. `npm run test:coverage` (suíte Vitest no workerd, com [test/wrangler.jsonc](test/wrangler.jsonc) hermético, cobertura Istanbul e limiares mínimos)
8. `npm run build` (`wrangler deploy --dry-run --outdir dist`)

Para atualizar [docs/tools.md](docs/tools.md) após alterar o registro de ferramentas:

```bash
npm run docs:tools
```

Verificações de rede real (`npm run test:contract`, `npm run verify:oauth`, `npm run verify:mcp`, `npm run verify:automation -- --read`, `npm run verify:chat-contract`) são opt-in e nunca compõem a suíte offline.

## Mapa da documentação

| Documento | Conteúdo |
|---|---|
| [docs/README.md](docs/README.md) | Índice geral da documentação vigente |
| [docs/tools.md](docs/tools.md) | Inventário de ferramentas MCP gerado de `tools/list` |
| [docs/architecture.md](docs/architecture.md) | Camadas, fluxo da automação, DO, fila/DLQ, cron e gate de orçamento |
| [docs/security.md](docs/security.md) | Modelo de ameaça, matriz de escopos, allowlist, fencing e evidência não confiável |
| [docs/operations/deploy.md](docs/operations/deploy.md) | Procedimento vigente de release e deploy |
| [docs/operations/rotation.md](docs/operations/rotation.md) | Rotação de segredos e revogação/renovação OAuth |
| [docs/operations/recovery.md](docs/operations/recovery.md) | Pausa, reconciliação, DLQ, revisões, retenção e rollback |
| [docs/operations/pilot.md](docs/operations/pilot.md) | Regras de verificação e piloto controlado |
| [docs/operations/scripts.md](docs/operations/scripts.md) | Catálogo dos scripts NPM e utilitários de `scripts/` |
| [docs/integrations/agendor-crm.md](docs/integrations/agendor-crm.md) | Contrato e limites da integração Agendor CRM |
| [docs/integrations/agendor-chat.md](docs/integrations/agendor-chat.md) | Contrato e limites da integração Agendor Chat |
| [docs/decisions/README.md](docs/decisions/README.md) | Registros de decisões arquiteturais (ADRs) |
| [docs/plano-refatoracao.md](docs/plano-refatoracao.md) | Plano de refatoração e correção do projeto |
| [docs/history/README.md](docs/history/README.md) | Arquivo histórico de planos, specs e logs datados |
| [CHANGELOG.md](CHANGELOG.md) | Histórico de versões e correspondência com versões Cloudflare |
| [AGENTS.md](AGENTS.md) | Convenções e regras para agentes que trabalham no repositório |
