# Recuperação, Pausa, DLQ e Rollback

Procedimentos operacionais vigentes para pausar a automação, reconciliar operações incertas/DLQ, resolver revisões e executar rollback com segurança.

## 1. Pausar e retomar a automação

1. Consulte o estado atual com `automation_get_status` (`automation:read`) para obter `policyVersion` e pendências.
2. Para pausar novos despachos da automação, chame `automation_update_policy` (`automation:manage`) com o `expectedVersion` exato:

   ```json
   {
     "expectedVersion": 6,
     "patch": { "mode": "disabled" }
   }
   ```

   Se ocorrer conflito de versão, releia `automation_get_status` antes de tentar novamente.
3. **Efeito da pausa**: `mode: "disabled"` invalida planos antigos e impede novos despachos do fluxo de automação, mas **não cancela** uma requisição HTTP já enviada ao Agendor e **não bloqueia** ferramentas CRM diretas (`crm_create_*`, `crm_enrich_*`, `crm_update_*`).
4. Para suspender **toda** escrita CRM imediatamente, interrompa os clientes escritores e revogue suas concessões/sessões de `crm:create`, `crm:enrich` e `crm:write` (veja [rotation.md](rotation.md)), preservando concessões de leitura necessárias à reconciliação.
5. Para retomar: valide catálogo, mapeamentos, política (`preview` ou `apply`) e `nativeCreatorDisabled`, atualize a política e gere novas preparações/análises. Aprovações antigas não migram para novos pedidos.

## 2. Reconciliação de operações (`queued`, `uncertain` e DLQ)

- Consulte `automation_get_operation` (`automation:read`) para inspecionar recibos, tentativas e motivos pendentes.
- **Regra absoluta**: nunca apague o Durable Object, `OAUTH_KV`, tabelas SQLite, tombstones ou filas para "limpar pendências", e **nunca** repita um `POST` para descobrir se um registro foi criado.
- **Watchdog e fila (`elo-agendor-operations`)**:
  - A fila executa com `max_batch_size: 1`, `max_concurrency: 1` e `max_retries: 4` (5 entregas totais).
  - Apenas rejeições conhecidas HTTP `429` permitem retry automático (respeitando `Retry-After` ou backoff `10 → 20 → 40 → 80 → 160` s, até o limite de 5 tentativas no ledger de execução).
  - O cron de 5 minutos (`*/5 * * * *`) e o alarme do DO (`WATCHDOG_INTERVAL_MS = 300_000`) expiram reservas abandonadas (> 30 s) e republicam referências vencidas de operações `queued`/`uncertain`.
- **DLQ (`elo-agendor-operations-dlq`)**:
  - Mensagens na DLQ contêm apenas `{ accountKey, operationId, version }`. O estado completo e os recibos permanecem seguros no DO `AutomationAccount`.
  - Quando uma operação esgota retries da fila ou cai em `uncertain`, reconcilie por leitura (`GET`) com `automation_get_operation` / consultas CRM diretas e resolva a revisão correspondente; para criações incertas de empresa/pessoa, a reconciliação só adota um registro quando uma busca limitada encontra exatamente uma correspondência completa por identificador forte (CNPJ ou e-mail).

## 3. Revisões humanas e reprocessamento

- **Listar revisões**: `automation_list_reviews` (`automation:read`, `chat:read`, `crm:read`) paginado por `cursor`.
- **Resolver revisão**: `automation_resolve_review` (`automation:manage`, `chat:read`, `crm:read`) exige `reviewId` e `expectedVersion`. A resolução invalida planos antigos, reabre apenas o mesmo `workId` e exige nova rodada `automation_prepare_sync` → `automation_submit_analysis` com as fontes atuais (a revisão é consumida por CAS ao gravar o novo plano). Decisões nunca migram para outra conversa nem concedem escopos CRM ausentes.
- **Reprocessar intervalo**: `automation_reprocess` (`automation:manage`, `chat:read`, `crm:read`) exige alvo explícito (`conversation` ou `customer`) e intervalo validado `from`/`to`, abrindo nova preparação em `preview` enquanto preserva registros de auditoria e efeitos incertos anteriores.

## 4. Retenção automática

- A manutenção do DO remove evidências, snapshots, fatos, demandas, contextos, revisões, eventos de descoberta e hints após **90 dias**.
- `execution_tombstones`, chaves de comando, recibos mínimos e auditoria operacional permanecem preservados para impedir duplicação ou reutilização indevida de `requestId` antigo.

## 5. Rollback de código

1. Antes de reverter para uma versão anterior no Wrangler, pause escritores/automação (`mode: "disabled"`), reconcilie operações `queued`/`uncertain` pendentes e verifique compatibilidade da versão alvo com o schema atual de `schema_migrations` (versões 1–8) e o formato da fila.
2. **Nunca** remova a classe `AutomationAccount` nem suas migrações DO em `wrangler.jsonc`, e **nunca** recrie `OAUTH_KV` como rollback.
3. Rollback de código não desfaz empresas, pessoas, negócios ou tarefas já criados no Agendor CRM; correções comerciais exigem ação explícita separada.
