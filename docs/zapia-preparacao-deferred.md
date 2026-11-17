# Investigação da preparação adiada — 10/11/2026

## Evidência da tentativa real

A consulta somente de leitura ao SQLite do Durable Object encontrou um único candidato com o modo, caixa, limites e janela informados:

- Trabalho `c7bfe26a-43cf-4115-849f-f507540dc7a2`; requestId `pending:82e53904124586656d1aabadf3f7b259dac66b92097cf23818288b37b9779599`; lease criado às 11h03:47 e expirado às 11h13:47 (Cuiabá).
- `preview`, inbox 4101, uma página de mensagens e zero páginas de anexos. O snapshot/manifesto versão 1 foi instalado às 11h06:26; contexto versão 0, seis páginas de catálogo e um alvo de hidratação processado.
- Snapshot armazenado com 100 mensagens e 18 referências de anexo provenientes das mensagens; não consta análise. A cobertura registra `attachment_page_limit`, `message_page_limit`, `attachment_collection_missing_media`, `history_end_not_reached` e `attachments_not_read`. O snapshot de trabalho tem cerca de 44 KB, abaixo do limite MCP de 512 KiB.
- Não existe entrada de preparação na auditoria para esse trabalho na versão 0.1.6. Seu proprietário pertence a um cliente OAuth diferente do usado pela segunda conexão consultada. O status e a auditoria de trabalhos filtram por usuário e cliente; esse isolamento explica por que a conexão consultada por nós não vê o trabalho. A identidade da segunda conexão relatada pelo operador não foi confirmada; portanto, a causa da diferença relatada continua uma hipótese. Os hints pendentes são contados para a conta inteira.

O SQLite comprova que o processamento chegou à persistência, mas não comprova o motivo de cada adiamento nem a causa da resposta ilegível. A consulta histórica de observabilidade retornou HTTP 403 porque a conexão Cloudflare não possui `workers-observability.write`; a revisão automática bloqueou reutilizar a credencial do Wrangler como forma de contornar esse 403. Não houve nova preparação real na investigação.

## Defeitos reproduzidos e correções

1. Adiamentos repetidos podiam continuar indefinidamente sem informar progresso ou motivo. `deferred` agora informa código sanitizado, progresso por fase, tentativas sem avanço e `retryAt`. Repetir antes de `retryAt` retorna a mesma resposta sem nova requisição; cinco tentativas sem progresso retornam `blocked` e orientação de recuperação.
2. Duas chamadas do mesmo trabalho podiam executar em paralelo mesmo com o lease por alvo. Uma trava SQLite por trabalho impede execução simultânea, renova antes das leituras, expira em até 60 segundos e usa fencing de posse. O lease de alvo continua com 600 segundos e é recuperado pela requisição inicial após a expiração.
3. Uma página de mensagens com identidade ou cursor inválido podia resultar em `ready` com cobertura parcial. Esses casos agora são encaminhados para revisão antes de ler candidatos CRM.
4. A auditoria registra aquisição do lease, criação do trabalho, progressos, razões sanitizadas de adiamento/falha, trava adquirida/liberada, bloqueio e persistência do snapshot. Não registra mensagens, credenciais, continuation ou tokens de lease.
5. O status separa trabalhos em preparação, aguardando agente, bloqueados e expirados por identidade OAuth. Cobertura parcial e trabalho expirado continuam explícitos.

## Limites e validação

`maxAttachmentPages=0` impede consulta à rota de anexos; metadados de anexos já embutidos em mensagens podem aparecer como referências, com cobertura parcial. Uma página limitada não comprova o fim do histórico. Falhas de persistência continuam resultando em erro estruturado e o pedido inicial idêntico pode recuperar o mesmo trabalho/lease.

O ensaio controlado local usa OAuth e MCP com workerd/SQLite, Agendor simulado, reinício do objeto, duas retomadas e zero páginas de anexos. A validação real de retomada no cliente Zapia permanece pendente, porque o operador determinou que nenhuma outra preparação fosse iniciada durante a investigação. O acesso aos logs históricos depende da reconexão Cloudflare com o escopo exigido. Não executar `automation_apply_plan` ou escrita no CRM.

## Publicação e testes da correção

O Worker `0.1.7` foi publicado como versão Cloudflare `816fc83d-752a-405d-87f9-b9cd2c6b0b67` a 100%. `server_status` confirmou `ok`; `automation_get_status` retornou `preview`, política 6 e zero operações pendentes para o cliente da verificação. Não foi iniciada outra preparação real.

Passaram 630 testes workerd em 45 arquivos, com arquivo E2E de aplicação excluído; após os ajustes finais passaram 49 testes direcionados e um ensaio OAuth/MCP de retomada em preview com reinício, além de typecheck e build dry-run. Os 26 testes de scripts também passaram. A validação de uma nova preparação real permanece pendente conforme instrução de não iniciá-la na investigação.
