# Confiabilidade Chat → CRM — implementação local

Desenho aprovado: [especificação](superpowers/specs/2026-10-28-agendor-reliability-design.md). Plano e decisões: [implementação](superpowers/plans/2026-10-28-agendor-reliability.md). O Worker existente foi atualizado em 2026-10-28 para servir esta implementação; nenhuma escrita CRM ou ativação de política ocorreu.

## Contratos e evidência

| Área | Implementação | Evidência e limites |
|---|---|---|
| Inboxes | Apenas 4101 e 4102; política vazia não permite nenhum; gates antes de conteúdo e antes de dispatch | Testes de gate e inbox movido entre entregas |
| Mensagens | after=1, cursor exclusivo pelo último ID a cada 100; batches duráveis, início/fim e contadores | Contrato validado pelo usuário nas conversas 42/203; testes sintéticos de 437 e 1200 registros, múltiplas páginas e orçamento |
| Edições | unavailable/upstream_whatsapp_api_limitation | Não há pendência reparável older_edits_not_covered |
| Conversas | page opcional, continuação quando há links.next da mesma origem/conta/rota; batches de até três páginas e deduplicação | Teste sintético: 1002 IDs em onze páginas. A coleção Postman consultada não especifica page/links; compatibilidade real ainda precisa ser validada |
| Conversas por contato | Mesmas regras, filtradas por inbox | Sem prova de terminal/paginação, conversation_pagination_incomplete |
| Listagem de anexos | Metadados de paginação preservados, batches, IDs únicos e reconciliação com mídias das mensagens | Sem links de paginação, attachment_pagination_unavailable; não deduzir completude de uma página curta |
| Conteúdo | HTTPS, hosts exatos, três redirects, MIME permitido, 20 MiB; PDFs/áudios como recurso binário | Leitura autenticada em 2026-10-28: `data_url` de anexo autorizado redirecionou para `agendor-chat-sa-production.s3.sa-east-1.amazonaws.com`; somente esse origin S3 exato foi permitido além de `chat.agendor.com.br`. Outros hosts continuam bloqueados |
| Identidade | Detalhe individual do contato renovado antes de getPerson(crmPersonId) | verified/direct_agendor_link; missing/stale/query_failed separados; orçamento recusado produz adiamento |
| Recuperação | Telefone/e-mail/CPF exatos; comparação local de prefixos e candidatos fracos separados | verified/no_candidate/ambiguous/query_failed; busca não é o caminho normal do vínculo válido |
| Duplicidade | Diagnóstico independente por CPF/e-mail ou nome+organização | none/possible_duplicate/high_confidence_duplicate/query_failed; nome isolado não basta; não há merge |
| Pessoas | Enriquecimento do registro existente; criação normal por automação bloqueada | Também protege planos antigos na fila; ferramentas CRM manuais mantêm autorização própria |

## Como retomar

`chat_list_messages` retorna até 100 mensagens e `continuation.after`. Ausência de cursor após chegar ao fim não prova início quando a leitura começou num after posterior. `coverage.history` informa startReached, endReached, messagesRead, pagesRead e complete. `messagePagination=verified` é evidência do contrato; `messageHistory` é a cobertura desta execução.

As ferramentas de coleções retornam `pageInfo.nextPage`; retome passando `page`. Batches iniciados depois da página 1 não alegam cobertura integral da coleção por conta própria. Contagens globais não são totais autorizados. A travessia só segue parâmetros extraídos de links válidos; não segue URLs livres retornadas pelo upstream. Se o endpoint não fornecer metadados reconhecidos, a ferramenta permanece parcial. Isso é ausência de contrato confirmado neste adaptador, não prova de uma limitação da API.

`automation_prepare_sync` preserva mensagens, metadados de anexos e páginas CRM bem-sucedidas antes de adiar. A fila preserva progresso de verificação por comando/fase e revalida inbox canônico em toda tentativa de dispatch. Recusas de crédito são aguardadas ou adiadas; toda requisição ainda exige reserva no mesmo gate durável. Não há limitador local substituindo o orçamento compartilhado.

## Conteúdo em partes

`chat_get_attachment` usa apenas conversationId/attachmentId da listagem. Pode receber `listingPage` para localizar metadados de outra página. Quando não encontra um ID em cobertura parcial, retorna attachment_listing_incomplete, e não inexistência conclusiva. Validação pós-deploy da conversa 42/anexo 9436584 retornou `available`, `audio/ogg`, 25,408 bytes, completo; o payload de áudio não foi exposto.

Um resultado disponível inclui sha256, totalBytes, offset, nextOffset e contentComplete. Se nextOffset não for null, repita com offset=nextOffset e expectedSha256=sha256. Reúna os blobs binários na ordem dos offsets; cada parte tem até 192 KiB. Alteração do arquivo produz attachment_changed. Texto pequeno e imagens completas podem usar os blocos nativos; conteúdo parcial/PDF/áudio usa recurso embutido. Áudio não é transcrito.

O limite de saída MCP de 512 KiB permanece. A implementação revalida o arquivo integral em cada chamada de parte: garante consistência por digest, mas implica releitura e consumo adicional de orçamento para arquivos grandes. Não cria armazenamento público nem expõe URLs assinadas.

O bloqueio de rede combina allowlist exata com o egress público do Worker, sem bindings privados. O projeto já usa global_fetch_strictly_public. Fundamentação: [modelo de bindings e SSRF](https://blog.cloudflare.com/workers-environment-live-object-bindings/) e [compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public). Testes com transporte injetado verificam decisões do adaptador; não comprovam o egress real da Cloudflare.

## Documentação consultada e validação ainda necessária

[Postman Chat](https://documenter.getpostman.com/view/28016625/2sAXxV4UX5), acessado pelo navegador em 2026-10-28: Get messages mostra after; Conversations/Attachments/Contact Conversations mostram rotas sem exemplos de corpos ou paginação nas seções consultadas. GET individual de contato também foi confirmado. A [OpenAPI CRM](https://api.agendor.com.br/v3/swagger.json) documenta paginação até 100 e filtros de busca, alguns por prefixo.

Validação autenticada real do Chat em 2026-10-28: inboxes observados limitados a 4101 e 4102; conversas pages 1, 2 e 3 retornaram 25 itens cada, IDs distintos entre páginas e sem metadados `next`/terminal; a cobertura permanece parcial. Para a conversa 42, attachments page 1 e page 2 repetiram os mesmos 17 IDs, sem metadados de continuação; a listagem permanece parcial. Um anexo listado redirecionou do endpoint autorizado para o host S3 documentado acima, que agora tem teste de redirect e allowlist exata. O conteúdo do anexo não foi apresentado ao usuário. Paginação/total exato de coleções continua sem contrato confirmado; as ferramentas informam cobertura parcial em vez de inferir completude.

Nova validação autenticada em 2026-11-01: na coleção geral, `page` retornou 25 conversas nas páginas 1–4 (100 IDs distintos nessa sequência), sem `links.next` ou sinal de fim. Em outra sequência, páginas 5–8 também retornaram 25 itens cada; numa repetição da varredura desde a página 1, páginas 5–9 vieram vazias. Páginas 9–14 também vieram vazias numa consulta separada. Portanto, a paginação existe e pode avançar, mas respostas de páginas vazias variaram entre execuções e não são evidência estável de terminal. Na coleção por contato, amostras também variaram: uma conversa reapareceu em página posterior numa execução; outro contato retornou duas conversas em página 1 e vazio em página 2; houve ainda respostas vazias para contatos que aparecem na coleção geral. Nenhuma resposta observada trouxe metadados de continuação. A ferramenta deve continuar expondo cobertura parcial; qualquer varredura automática é apenas best-effort e não prova exaustividade.

Na mesma validação, `page=1` sem filtro de status retornou apenas conversas `open`; `status=resolved` retornou apenas resolvidas e `status=all` retornou a mistura. Assim, a omissão do filtro pode esconder atendimentos encerrados. O adaptador local agora envia `status=all` por padrão e preserva filtros explícitos. Uma resposta `status=all` também variou entre vazia e com registros em chamadas distintas, então a cobertura segue parcial.

## Verificação

`npm run test:adapters` roda os testes de adaptadores em Node sem credenciais/runtime Cloudflare. `npm test -- --maxWorkers=1` roda a suíte do Worker; nesta máquina precisou sair do sandbox para o runtime iniciar corretamente. Scripts: npm run test:scripts; tipos: npm run typecheck; verificador: npm run verify:automation (offline).

O build dry-run precisou usar `npx wrangler deploy --dry-run --outdir .tooling/reliability/build`, pois os arquivos existentes de dist estavam bloqueados. Isso não publicou o Worker.

As três falhas preexistentes de custom fields foram reproduzidas no HEAD intacto (68/71) e depois corrigidas: IDs ausentes/inválidos agora não podem corresponder a uma entrada de catálogo; fatos customFields.undefined são rejeitados; e a criação envia custom fields indexados pelo ID do catálogo, não pelo nome de exibição.

Resultado após a correção: 605/605 testes passaram na suíte completa; os 71 testes de regressão de custom fields passaram. Adaptadores25/25, scripts26/26 e TypeScript também passaram na validação anterior. O resultado da suíte foi executado no checkout da tarefa, sem credenciais de produção.
