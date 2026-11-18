# Confiabilidade Agendor Chat → CRM

Data: 2026-10-28. Proposta para aprovação; código de produto ainda não alterado.

## Escopo

Implementar o pedido anexado: somente inboxes 4101 e 4102, paginação de mensagens, descoberta de conversas/anexos, download seguro, identidade canônica por crmPersonId e enriquecimento da Pessoa existente. Duplicidades seguem para revisão humana. Transcrição e merge automático estão fora do escopo.

## Evidência e diagnóstico

Separar comportamento relatado, documentação e execução real do adaptador.

- Usuário: conversas 42 e 203 validaram after=1, páginas de 100, exclusão do cursor e ordem cronológica. Esses testes foram relatados, não executados nesta sessão.
- Documentação Chat acessada pelo navegador em 2026-10-28: https://documenter.getpostman.com/view/28016625/2sAXxV4UX5. Get messages documenta after=189. List all conversations mostra status, assignee_type_id, sort_order e assignee_type. Get Attachments mostra a rota, sem paginação ou exemplo de resposta nessa seção. Ausência na coleção não prova indisponibilidade na API.
- OpenAPI CRM acessada: https://api.agendor.com.br/v3/swagger.json. Page, tamanho até 100 e links/meta. Filtros de prefixo precisam de comparação exata local para identidade.
- client.ts emite flags parciais fixas e não produz continuação.
- contacts.ts limita leitura agregada a 100 mensagens e cinco páginas; adiciona older_edits_not_covered para qualquer cursor.
- service.ts permite todos os inboxes quando allowlist está vazia e verifica inbox depois de ler mensagens/anexos.
- identity.ts faz buscas antes de consultar crmPersonId; mistura ausência, indisponibilidade e conflito de candidatos.
- attachments.ts recusa redirects, limita a 5 MiB e aceita texto/imagens. O MCP serializa qualquer binário como imagem e limita saída total a 512 KiB.

## Abordagem recomendada

Corrigir adaptadores e integrar cobertura ao fluxo durável existente, preservando orçamento compartilhado, autenticação, escopos e retomada. Alterar somente rótulos manteria os cortes de leitura; reescrever o MCP ampliaria o escopo. Recomendação técnica do implementador, ainda sem aprovação do usuário.

## Inboxes

Autorização inicial: [4101, 4102]. Lista vazia significa nenhum inbox. Política pode restringir; expansão exige autorização explícita. Atualizar defaults e manifesto sem ativar apply ou conceder capabilities.

Filtrar descoberta geral e por contato. Para um ID conhecido, consultar detalhe mínimo e verificar inbox antes de mensagens/anexos/CRM. Inbox ausente bloqueia processamento. Aplicar a prepare, retomada, reprocessamento e sincronização por cliente. Antes de dispatch da fila, conferir política atual e inbox canônico novamente; trabalhos antigos não têm exceção. Cron apenas mantém/republica referências, cuja execução passa pelo mesmo gate.

## Histórico e cobertura

Contrato de mensagens verificado pela evidência do usuário: começar after=1; página de 100 continua pelo último ID; resposta menor/vazia encerra sob esse contrato. Página cheia exige outra consulta. Detectar cursor repetido/regressivo, ordenação inconsistente e mensagens de outra conversa.

Separar capacidade verificada de cobertura calculada: messagePagination=verified pode coexistir com messageHistory=partial. Histórico informa startReached, endReached, messagesRead, pagesRead, complete e missingReasons. Contar IDs únicos. Cursor posterior não comprova início. Remover corte agregado de 100; manter batches limitados com progresso persistido, inclusive quando orçamento adiar uma página. Limite produz continuação, nunca completude artificial.

Preservar resumo complete/missingReasons/pagesRead e acrescentar dimensões opcionais nos schemas estritos, snapshots, manifests, persistência e projeções. Dados antigos continuam legíveis sem promoção retroativa de cobertura.

Edição upstream sem conteúdo: unavailable/upstream_whatsapp_api_limitation, sem pendência older_edits_not_covered. Não detectar edição só por palavras no texto de clientes.

## Descoberta e anexos

Investigar GETs dirigidos com orçamento compartilhado para conversas, conversas por contato e anexos. Confirmar que continuação muda IDs, não repete a página inicial e termina conforme metadados/contagens do mesmo escopo. Não assumir page/perPage sem evidência específica do endpoint. Preservar metadados na normalização: hoje as transformações de coleções os descartam.

Deduplicar IDs e contabilizar exclusões por inbox. Contagem global não é total autorizado. Se não houver prova, usar conversation_pagination_incomplete ou pagination_unavailable e registrar o que foi consultado.

Preservar mídias do histórico e reconciliar IDs/messageIds com coleção de anexos, inclusive vários anexos por mensagem. Coincidência entre coleções parciais não prova completude. Listagem e conteúdo têm estados separados.

## Download e entrega

Observar URLs e Location reais sem registrar URLs assinadas; o erro redirect_not_allowed atual não revela o host. Permitir somente hosts exatos comprovados, sem curingas gerais de storage ou destinos livres do chamador. Sem host confirmado, manter bloqueio com motivo específico.

HTTPS, porta padrão, sem credenciais; validar destino inicial e cada salto, no máximo três redirects. Bloquear redes locais/privadas/link-local IPv4 e IPv6, formas alternativas normalizadas e IPv4 mapeado. Verificar resolução para destinos não públicos; se o runtime não garantir essa verificação para um host, bloqueá-lo. Nunca enviar token Chat nos downloads. Cancelar corpos descartados e preservar timeout total, cancelamento e orçamento por requisição.

Teto de download: 20 MiB (decisão técnica: 20 × 1.048.576 bytes). Validar tamanho declarado e stream real. MIME: PDF, JPEG, PNG, OGG, MPEG, MP4 de áudio e texto. Conteúdo permanece não confiável.

Texto em bloco texto; imagens em image; PDF em recurso binário embutido; áudio em audio se suportado pelo protocolo/cliente, senão recurso binário. Não enviar áudio/PDF como imagem. Preservar teto MCP de 512 KiB e testar expansão base64. Arquivo maior produz output_size_limit, distinguindo download bem-sucedido de entrega não disponível; não declarar leitura utilizável verificada nesse caso. Um canal autenticado para arquivos maiores pode ser etapa posterior; não criar URLs públicas nem expor links assinados como atalho.

## Identidade e candidatos

Primeiro getPerson(crmPersonId). Registro válido e ID correspondente: crmContactLink=verified, method=direct_agendor_link, candidateRead=not_needed; incluir Pessoa canônica no snapshot para enriquecimento. Comparações diagnósticas não substituem o vínculo.

ID ausente: missing. Somente não encontrado conclusivo: stale. Timeout, 401/403/429/5xx, JSON inválido ou ID divergente: query_failed, sem inferência de ausência/criação.

Missing/stale acionam recuperação: telefone exato, e-mail exato, CPF exato disponível, nome+organização e nome. Paginar filtros de prefixo e comparar exatamente valores normalizados. Nome sozinho só sugere. Candidato forte único: verified e matchedBy; múltiplos fortes ou identificadores conflitantes: ambiguous; buscas completas sem resultado: no_candidate; falha/incompletude: query_failed ou cobertura parcial específica. Separar busca de Organização do matching de Pessoa. CPF exige campo e evidência disponíveis.

Duplicidade é diagnóstico independente, com CPF/e-mail ou nome+organização/histórico comprovado. Telefone diferente não exclui duplicidade. Não mudar Pessoa canônica, mesclar, excluir ou sobrescrever conflitos. none exige busca completa; caso não feita ou falha, estado diagnóstico específico. Fatos novos da análise exigem nova preparação verificada. Alterações conflitantes seguem para revisão, sem invalidar o vínculo direto válido.

Nova Pessoa por automação fica bloqueada no fluxo normal. Exceção exige decisão humana explícita, busca confiável completa e recente, releitura do contato antes de dispatch e proteção contra criador nativo concorrente. Enriquecimento de Pessoa existente não exige desligar criador nativo. Ferramentas manuais preservam autorização própria, sem presumir proveniência Chat ausente.

## Implementação e aceite

1. Política de inbox: lista vazia, inbox ausente, retomada antiga e mudança de caixa antes de dispatch.
2. Cobertura e histórico: 437 mensagens, múltiplo exato de 100, cursor repetido/regressivo, mensagens duplicadas, falha intermediária e retomada após esgotar orçamento.
3. Vínculo direto: consulta antes de search, nenhuma busca desnecessária, 404 versus timeout, IDs divergentes e ambiguidade.
4. Duplicidade/criação: número novo, nome igual sem suporte e enriquecimento do registro existente.
5. Descoberta e anexos: mais de 1000 conversas sintéticas, allowlist, preservação de metadados e múltiplas mídias; confirmar contratos reais ou declarar limitação específica.
6. Download: hosts comprovados, destinos privados, quatro saltos, timeout, tamanho mentiroso, MIME proibido, áudio/PDF e expansão base64.
7. Atualizar descrições MCP, contratos, scripts e documentação operacional, distinguindo testes sintéticos de leituras reais.

Checks: npm test, npm run test:scripts, npm run typecheck, npm run build (dry-run), npm run verify:automation (offline). Leituras reais dirigidas somente aos inboxes autorizados. Sem operações comerciais ou deploy nesta fase. Build/testes aprovados não comprovam contratos ao vivo.

Aceite: nenhum conteúdo de inbox não autorizado processado automaticamente; cobertura real sem flags genéricas já superadas; identidade canônica prioritária; nenhuma criação duplicada ou merge automático; listagem/download só verified com evidência correspondente e limitações concretas visíveis.

## Complemento documental

A seção Contacts confirma GET /contacts/{contact_id}, GET /contacts/search?q= e GET /contacts/{contact_id}/conversations. Esta última não mostra paginação nem corpo de exemplo. O cliente local consulta a coleção parcial para getContact, apesar de existir rota individual documentada. A implementação deve usar o detalhe individual para renovar o vínculo canônico e evitar tratar ausência na coleção como ausência do contato.

## Revisão de viabilidade

A revisão independente apontou dois pontos que precisam ficar explícitos no plano:

1. Entrega de conteúdo grande é requisito desta entrega. A proposta anterior de simplesmente encerrar com output_size_limit não satisfaz o pedido. Implementar leitura autenticada em partes por conversationId/attachmentId, offset e limite de bytes, sem aceitar URL arbitrária. Cada parte deve caber no limite MCP, com metadados de tamanho, MIME e identidade/digest para impedir concatenar versões diferentes. Disponibilizar todo arquivo permitido até 20 MiB por partes, sem elevar indiscriminadamente o teto global nem publicar arquivos. A escolha entre recurso autenticado e ferramenta adicional é do implementador, condicionada ao suporte real do cliente; testar o acesso integral ao conteúdo. Uma recusa por limite de saída nunca equivale a leitura verificada.

2. Garantia de destino público precisa ser provada no transporte real. Pré-consulta DNS seguida de fetch independente não garante o mesmo endereço e não satisfaz a proteção contra rebinding. Na etapa de investigação, conferir garantias documentadas do egress Cloudflare e o controle de resolução/conexão disponível. Se não houver garantia adequada, usar transporte de egress que a imponha ou declarar essa parte bloqueada, com motivo implementation_missing, sem liberar hosts por heurística. Essa dependência técnica não exige decisão comercial do usuário, mas impede prometer attachment_content_read=verified antes da solução e dos testes.
