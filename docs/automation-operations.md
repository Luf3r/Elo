# Operação do fluxo Agendor

O agente prepara e interpreta conversas por chamada autenticada. O núcleo não depende de um agendador: aplicações interativas e entregas de Queue compartilham o mesmo registro persistente de comandos. Nenhum alarme ou cron inicia inferência.

## Recuperação e pausas

Cada operação queued/uncertain registra uma entrega persistente antes da publicação na fila. Falha na publicação mantém a referência; o alarme e o watchdog de cinco minutos republicam referências vencidas. A fila contém somente accountKey, operationId e version. A DLQ `elo-agendor-operations-dlq` preserva esse mesmo envelope; o registro durável permite recuperação mesmo após esgotar as quatro redeliveries da fila. Republicações podem se repetir, mas nunca concedem uma nova tentativa de escrita por conta própria.

Somente uma rejeição conhecida 429 permite nova tentativa: Retry-After é respeitado e, quando ausente, o atraso aumenta de 10 para 20, 40, 80 e 160 segundos. Após cinco tentativas de envio o comando exige revisão. Efeito incerto ou claim de envio abandonado exige GET/reconciliação e jamais autoriza repetir POST. Reservas expiradas não consomem tentativas. Os fences e as chaves de comandos permanecem para impedir duplicação.

Uma autorização de operação dura no máximo cinco minutos e nunca ultrapassa a concessão do ator. Expiração exige nova chamada autenticada; o watchdog não renova permissões. Pausar usa automation_update_policy com mode=disabled e expectedVersion. A mudança invalida planos e impede novos envios da automação. Comandos diretos continuam vinculados à autorização explícita de seu ator. Resultados já enviados podem ser reconciliados por leitura, preservando recibos e contexto. Retomar exige evidência atual e um novo plano; rollback de código não desfaz efeitos no CRM.

## Revisões, auditoria e contexto

automation_list_reviews e automation_resolve_review exigem seus escopos de leitura/gestão. A resolução compara reviewId e expectedVersion, verifica plano/cliente/demanda/fonte conforme a decisão e invalida planos anteriores. A decisão retorna ao agente para nova preparação e análise; não cria uma permissão para pedidos futuros nem contorna os escopos CRM. Aprovação identifica somente planId e planVersion.

A resolução reabre somente o mesmo workId, avança a versão do snapshot e exige novos GETs. O preparo expõe reviewDecision tipada. A próxima submissão deve repetir a análise original: o servidor aplica a seleção/correção, valida as fontes atuais e cria outro plano. A gravação desse plano consome a revisão por CAS e registra review_consumed; decisões não migram para outra conversa, pedido ou ator. Seleção de demanda exige exatamente uma demanda na análise revisada. Fontes alteradas exigem outra revisão; aprovação não contorna cobertura, identidade, política ou validação de campos.

automation_reprocess aceita alvo explícito de conversa ou cliente, intervalo from/to e mode (preview por padrão); preserva o pedido delimitado e um registro auditável. Nenhuma revisão, atualização de política ou solicitação de reprocessamento escreve no CRM por si só.

automation_list_audit retorna páginas de códigos de ação, timestamps, versão e identificadores para o mesmo userId/clientId. Não contém decisão textual, mensagens, anexos, credenciais nem leaseToken. Os logs técnicos não imprimem corpos upstream. automation_get_status informa ready/degraded/paused, pendências, trabalho aguardando agente e contagem de cobertura incompleta.

Uma projeção estruturada de fatos e demandas fica pendente após a análise. Quando os comandos da operação são confirmados, a entrega publica o Markdown com os recibos canônicos. A publicação é idempotente e compara a versão do contexto; não substitui contexto de outra versão. Falha de publicação preserva a projeção para recuperação e revisão.

## Retenção

Evidências, snapshots, fatos, contexto, demandas e conteúdo de revisões expiram após 90 dias. A manutenção remove também os payloads de execução históricos, mantendo tombstones de operação/requestId e as chaves de comandos com recibos mínimos. Identificadores, fingerprints, fences e auditoria operacional preservam deduplicação; não se deve apagar tabelas para “retentar” uma criação incerta. Referências de hints expiram em 90 dias, preservando sua chave e hash para deduplicação.

## Ingresso opcional

POST /automation/chat-events fica desabilitado (404) por padrão: não há contrato de assinatura/webhook Agendor comprovado neste projeto. AUTOMATION_CHAT_HINTS_ENABLED=true habilita deliberadamente apenas um endpoint de dicas sem assinatura, sem cadastro automático de webhook. Ele aceita somente eventId, accountId e conversationId; exige a conta fixa AGENDOR_CHAT_ACCOUNT_ID, JSON de até 8 KiB, no máximo 30 dicas novas por minuto e 1.000 referências pendentes. Repetição é deduplicada e eventId reutilizado com outro destino retorna conflito.

Uma dica nunca instala snapshot, fato, cliente, demanda ou comando e não chama CRM/Chat. Somente nova preparação autenticada por GET pode produzir evidência canônica. Este endpoint não deve ser anunciado como consumidor do formato nativo do Agendor até verificar o contrato e a assinatura suportada.

## Verificação local

Use npm test, npm run test:scripts, npm run typecheck e npm run build. Os testes de manutenção cobrem retenção, chaves, 429/backoff, limite de tentativas, expiração de reservas, pausa, falha de publicação, contexto e CAS de revisão. Os testes de ingresso usam somente dicas sintéticas e validam conta, tamanho, quota, deduplicação e ausência de efeitos canônicos. Nenhuma destas verificações exige escrita em produção.

`npm run verify:automation` termina em `offline`, sem ler credenciais nem chamar rede. A leitura remota exige um alvo deliberado: `npm run verify:automation -- --read --conversation 101`. O verificador usa a sessão OAuth local validada por `oauth-session.mjs`, negocia MCP pelo SDK e chama status/preparo em `preview`. `--analysis caminho.json` permite submeter uma análise com as revisões exatas retornadas pelo preparo; submit persiste plano/contexto pendente e continua sem escrever CRM. `deferred` encerra o ensaio para respeitar `retryAt`; continuações são limitadas a dez chamadas. A saída contém somente ferramenta, código, estado fechado e contagem, sem mensagens, contatos, Markdown, tokens ou lease. Erros e estados inesperados são sanitizados; encontrar um segredo conhecido no resultado faz a verificação falhar. O transporte recusa redirecionamentos.

Escrita exige simultaneamente `--read --write --analysis caminho.json --pilot manifesto.json`. O manifesto é uma autorização deliberada do piloto, com `approvedBy`, `expiresAt`, `requestId` do preparo já revisado, `conversations: [{id,inboxId}]`, `records: [{kind,id}]` e `operations: [{commandKey,kind,sha256}]`. Cada hash deve ser `commandDigest(comando)` exportado pelo script, calculado sobre o comando completo do plano revisado; ele inclui payload, destino, fontes e dependências. Prepare esse trabalho em modo apply com o mesmo requestId antes de autorizar o manifesto. O verificador reutiliza o trabalho e a análise, recusa registros ou comandos fora da lista e só então chama `automation_apply_plan` para a versão exata retornada. `inboxId` registra a caixa autorizada para aquela conversa no manifesto; o DTO atual de conversa não comprova caixa, portanto o operador deve conferir esse vínculo ao autorizar o piloto. As ferramentas diretas create/enrich nunca são usadas pelo verificador.

Uma repetição exata de apply concluído devolve os recibos mesmo após a publicação invalidar o plano original, com conferência de ator, conta, planId e versão. Não cria nova autorização de envio. Após retenção, o tombstone preserva a deduplicação e o pedido antigo é recusado.

Validação da Task 14: o ensaio local usa conversas e registros sintéticos através de cliente MCP real, com adaptadores simulados e bloqueio de rede. GET/preview remoto e piloto de escrita não foram executados: nenhuma conversa real delimitada ou manifesto autorizado foi fornecido. Produção não é usada como fixture e nenhuma escrita real compõe a verificação ordinária.

## Rollout inicial e gate de criação

O artefato [rollout-pilot.json](rollout-pilot.json) é o manifesto exato de preparação, sem autorização: modo disabled, capacidades/caixas/mapeamentos e todos os alvos vazios; criador nativo não comprovado. Não é lido pelo runtime e não serve como manifesto válido de `--write`. Conta, endpoint e owner permanecem os existentes. Nenhum DO/fila/secret/política remotos foi alterado neste fechamento.

O modo da aplicação, capacidades, mapeamentos reais, caixas e exclusividade são política versionada, separada da configuração de infraestrutura e da concessão OAuth. `allowedInboxIds` agora é verificado no preparo e novamente no apply: toda conversa precisa trazer `inboxId` comprovado e pertencer à lista permitida. `nativeCreatorDisabled` também é uma barreira no autorizador final; precisa ser `true` antes de qualquer mutação CRM. A cobertura do Chat continua explícita e, sem vínculo conversa/caixa ou histórico suficiente, o fluxo deve permanecer em review/preview.

## Pausa, retomada e rollback do rollout

1. Leia `automation_get_status` com `automation:read` e obtenha policyVersion. O gestor chama `automation_update_policy({expectedVersion:<versão atual>,patch:{mode:"disabled"}})` com `automation:manage`; se houver conflito, releia em vez de repetir com versão inventada. Confirme status paused/disabled e preservação do histórico. Essa pausa bloqueia novas reservas/envios de planos de automação; não cancela uma requisição já entregue ao provedor.
2. Ferramentas diretas e os quatro updates legados mantêm autorização própria e não são pausados por essa política. Para suspender toda escrita, interrompa os clientes escritores e revogue suas concessões/sessões de `crm:create`, `crm:enrich` e `crm:write` pelo fluxo OAuth existente. Preserve concessões de leitura necessárias à reconciliação. Não considere a política disabled um bloqueio global das ferramentas diretas.
3. Liste operações/revisões e acompanhe recibos. Reconcile efeitos enviados/incertos somente por leituras autorizadas; não repita POST para descobrir se criou. Queue/DLQ/outbox são referências recuperáveis; não apague DO, KV, tabelas, chaves ou filas para limpar pendências. A expiração da autorização impede novos envios, mas não elimina efeitos já ocorridos.
4. Para retomar, confira catálogo/fontes/contexto, exclusividade do criador e alvos. Uma nova política/versão e novas preparação/análise geram o plano atual; autorização expirada precisa de nova chamada autenticada. A aprovação antiga não migra para novos pedidos. Só uma autorização concreta do manifesto e os gates verificados permitem apply.
5. Rollback de código exige aprovação do destino/versão e revisão de compatibilidade com migrações SQLite, consumidor e estado atual. A publicação histórica de 15 ferramentas não entende o novo estado/fila; antes de selecioná-la, pause escritores, preserve o Worker compatível para reconciliação e trate pendências. Não remova a classe/migração DO nem recrie o namespace como rollback. Código anterior não desfaz empresas, pessoas, negócios, tarefas, vínculos ou alterações no CRM; correções comerciais são decisões separadas com recibos e autorização própria.

## Limites conhecidos e aceitação pendente

O coordenador protege concorrência interna, revalida snapshots antes/depois e preserva edição humana observável, mas a API CRM não fornece CAS condicional para eliminar a janela entre GET e PUT/POST de consumidores externos. Efeito incerto fica em revisão, sem nova criação automática. Chaves de deduplicação não tornam a API upstream idempotente.

Histórico completo, descoberta exaustiva, edições antigas e caixa da conversa não estão comprovados no Chat; ausência em página parcial não prova inexistência. Anexo listado não significa lido: origem autorizada, MIME, bytes, formato ou suporte do cliente MCP podem impedir análise. A cobertura necessária permanece review quando incompleta; não promover esses gates manualmente só para obter ready.

`products_entities` (inclusive preços) fica bloqueado; PUT de `customFields` e `assigned_users` fica bloqueado enquanto merge/substituição/remoção não forem comprovados. Criação pode inicializar campos suportados e responsáveis validáveis; não equivale à validação comercial real. Funis Ativo/Passivo, quatro etapas, aprovação interna Elo, responsável, datas/logística, itens e vínculos precisam de IDs/catálogos e evidências reais do piloto; mapeamentos iniciais são vazios. O CLI de descoberta de contratos reais continua sem transporte compartilhado autorizado e falha fechado.

O ensaio sintético local verifica o encadeamento MCP com adaptadores mockados; não é uma sessão de IA interpretando mensagens reais, nem prova suporte de anexos no ChatGPT/Zapia. Não houve leitura real, piloto de escrita, conferência comercial no CRM ou publicação desta ampliação. O relatório final deve manter essas fases pendentes explícitas.
