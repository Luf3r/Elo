# Operação do fluxo Agendor

O agente prepara e interpreta conversas por chamada autenticada. O núcleo não depende de um agendador: aplicações interativas e entregas de Queue compartilham o mesmo registro persistente de comandos. Nenhum alarme ou cron inicia inferência.

## Recuperação e pausas

Cada operação queued/uncertain registra uma entrega persistente antes da publicação na fila. Falha na publicação mantém a referência; o alarme e o watchdog de cinco minutos republicam referências vencidas. A fila contém somente accountKey, operationId e version. A DLQ `elo-agendor-operations-dlq` preserva esse mesmo envelope; o registro durável permite recuperação mesmo após esgotar as quatro redeliveries da fila. Republicações podem se repetir, mas nunca concedem uma nova tentativa de escrita por conta própria.

Somente uma rejeição conhecida 429 permite nova tentativa: Retry-After é respeitado e, quando ausente, o atraso aumenta de 10 para 20, 40, 80 e 160 segundos. Após cinco tentativas de envio o comando exige revisão. Efeito incerto ou claim de envio abandonado exige GET/reconciliação e jamais autoriza repetir POST. Reservas expiradas não consomem tentativas. Os fences e as chaves de comandos permanecem para impedir duplicação.

Uma autorização de operação dura no máximo cinco minutos e nunca ultrapassa a concessão do ator. Expiração exige nova chamada autenticada; o watchdog não renova permissões. Pausar usa automation_update_policy com mode=disabled e expectedVersion. A mudança invalida planos e impede novos envios da automação. Comandos diretos continuam vinculados à autorização explícita de seu ator. Resultados já enviados podem ser reconciliados por leitura, preservando recibos e contexto. Retomar exige evidência atual e um novo plano; rollback de código não desfaz efeitos no CRM.

## Revisões, auditoria e contexto

automation_list_reviews e automation_resolve_review exigem seus escopos de leitura/gestão. A resolução compara reviewId e expectedVersion, verifica plano/cliente/demanda/fonte conforme a decisão e invalida planos anteriores. A decisão retorna ao agente para nova preparação e análise; não cria uma permissão para pedidos futuros nem contorna os escopos CRM. Aprovação identifica somente planId e planVersion.

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
