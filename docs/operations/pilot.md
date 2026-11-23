# Verificação e Piloto Supervisionado

Regras vigentes para ensaios controlados de leitura e piloto de escrita com `verify:automation` e clientes MCP.

## 1. Verificação offline e leitura opt-in

- **Padrão offline (zero chamadas remotas)**:

  ```bash
  npm run verify:automation
  ```

  Retorna estado `offline` com `remoteCalls: 0`, sem ler `.dev.vars` ou acessar rede.
- **Leitura controlada (`--read`, modo `preview`)**:
  Exige sessão OAuth local prévia (`npm run oauth:login`) e alvo explícito:

  ```bash
  npm run verify:automation -- --read --conversation <CONVERSATION_ID>
  ```

  Opcionalmente informe `--analysis <caminho.json>` para submeter análise em `preview` (persiste plano e projeção pendente, **sem** chamar `automation_apply_plan` e sem escrever no CRM). O verificador encerra ao receber `deferred` para respeitar `retryAt`, limita continuações a 10 chamadas, recusa redirects e falha fechado se detectar qualquer segredo conhecido na saída.

## 2. Pré-requisitos do piloto supervisionado de escrita (`--write`)

Nenhuma escrita automatizada deve ser executada sem atender simultaneamente a todos os gates abaixo:

1. **Política vigente no DO (`automation_get_status`)**:
   - Modo `apply` deliberadamente configurado na política atual do DO (`policyVersion` conhecida).
   - `allowedInboxIds` restrito às caixas autorizadas da implantação, por exemplo `[4101, 4102]` em `test/wrangler.jsonc`, ou a um subconjunto.
   - `capabilities` mínimas necessárias e alinhadas aos escopos OAuth do cliente executor.
   - Mapeamentos reais de funis (`funnelMapping`), etapas (`stageMapping`) e campos personalizados (`customFieldMapping`) conferidos contra o catálogo CRM.
   - `nativeCreatorDisabled` validado (permanecendo `false`, `create_person` é bloqueado pelo autorizador final).
2. **Manifesto de autorização explícita do piloto (`--pilot <manifesto.json>`)**:
   A execução de escrita exige `--read --write --analysis <caminho.json> --pilot <manifesto.json>` contendo:
   - `approvedBy` (identificação do aprovador humano) e `expiresAt` válido;
   - `requestId` exato do preparo já revisado em modo `apply`;
   - `conversations: [{ id, inboxId }]` (conferido pelo operador contra a caixa esperada);
   - `records: [{ kind, id }]` (registros exatamente autorizados);
   - `operations: [{ commandKey, kind, sha256 }]` onde cada `sha256` corresponde a `commandDigest(comando)` calculado sobre o comando completo (payload, destino, fontes e dependências).
3. **Invariantes durante o piloto**:
   - Use alvo `conversation` explícito (nunca varredura ampla como fixture de escrita).
   - Mantenha clientes de leitura/preview (como Zapia na fase de preview) apenas com `automation:process`, `automation:read`, `crm:read`, `chat:read` — sem `crm:write`, `crm:create`, `crm:enrich` ou `automation:manage`.
   - `products_entities` e `PUT` de `customFields`/`assigned_users` permanecem bloqueados até comprovação da semântica de coleção na API CRM.
   - Produção nunca deve ser usada como fixture de teste automatizado.
