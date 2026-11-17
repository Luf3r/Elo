# Fase B do Zapia — relatório de segurança e validação

Atualização da descoberta e do roteiro de homologação: [T01 em preview](zapia-t01.md). O registro abaixo descreve a validação anterior à descoberta.

Data da verificação 2026-11-10. **Candidato local validado. Liberação do piloto pendente do ensaio no Zapia e da verificação do isolamento no transporte do Agendor Chat.**

A consulta autenticada ao Worker publicado retornou `server_status: ok` (aplicação `0.1.2`) e `automation_get_status` retornou `mode: preview`, `policyVersion: 6`, zero revisões, zero operações pendentes e zero hints pendentes. O catálogo da conexão disponível ainda não expõe `automation_preflight_sync`. A sessão usada para essa consulta é a do conector Elo Agendor. O teste no cliente OAuth da conta Zapia segue pendente. A política publicada v6 foi preservada.

## Implementação encontrada e alterações

| Área | Comportamento anterior | Candidato |
|---|---|---|
| Seleção | `conversation` usava o ID exato. `customer` recuperava até 10 IDs de referências a mensagens no contexto persistido. `pending` já era recusado. | A conversa explícita continua sendo exatamente uma. O alvo por cliente consulta somente referências de IDs na seleção e exige a prova de todas as conversas antes de ler conteúdo. Aplica o menor limite entre 10 e `policy.limits.maxConversations`. Acima do limite, exige um alvo mais específico. |
| Autorização de inbox | A allowlist fixa 4101/4102 já era intersectada com a política. A leitura inicial verificava o inbox antes das rotas de conteúdo. Retomadas na fase CRM e replays prontos podiam confiar no inbox persistido. | Um ID ausente, conflitante, diferente do solicitado ou fora do recorte bloqueia o processamento. A preparação refaz a sondagem canônica em toda chamada, inclusive replay pronto e retomada só de CRM. Antes dos acessos a conteúdo, o recorte é comparado com a política atual. Se o inbox mudou desde o snapshot parcial, exige nova preparação. |
| Agendor Chat | GET no detalhe, GET do contato individual, listagem de metadados de anexos e páginas de mensagens. | Mesmas rotas. O detalhe usado para autorização projeta somente ID, inbox e ID de contato. O conteúdo de anexos não é baixado na preparação. |
| Paginação | Mensagens com `after=1` e cursor crescente exclusivo, até 100 mensagens por página e 10 páginas por lote. Anexos em lotes de até 3 páginas com link de continuação válido e cobertura parcial quando faltar evidência. | Limites totais por conversa persistidos com o trabalho. Se o limite interromper a leitura, a cobertura registra `message_page_limit` ou `attachment_page_limit`. `ready` autoriza a análise da evidência disponível e pode ter cobertura parcial. |
| Persistência | Durable Object SQLite, com progresso de anexos, mensagens, pesquisas CRM e catálogo. Lease por alvo de 600 s com fencing e revisão do workflow. Snapshot final e manifesto eram gravados em chamadas separadas. | Manifesto e snapshot final são gravados em uma transação. Uma renovação usa a versão anterior mais um, inclusive quando o ID de trabalho é reutilizado. Uma submissão idêntica da mesma base reaproveita a projeção pendente mesmo que o horário de tentativa tenha mudado. |
| Deduplicação | O mesmo `requestId` com a mesma identidade, alvo e payload reutilizava o lease vigente. Um payload diferente conflita. Hints são identificados por conta/evento e fingerprint e não selecionam conversas para `pending`. | Recorte e limites entram no fingerprint da preparação. Os cursores e dados de progresso continuam vinculados à conta, ao cliente OAuth, ao trabalho e ao lease. Hints repetidos continuam deduplicados após reinicialização do objeto. |

A preparação consulta `/accounts/{account}/conversations/{id}`, `/accounts/{account}/contacts/{id}`, `/accounts/{account}/conversations/{id}/attachments` e `/accounts/{account}/conversations/{id}/messages?after={cursor}`. Após a prova de escopo, usa leituras CRM para candidatos, catálogo e registros vinculados. A janela compartilhada de quatro requisições por produto a cada dez segundos segue em vigor. O limite de requisições da política governa catálogo e hidratação por chamada. As buscas de candidatos têm limites próprios.

## Contrato MCP

Os dois métodos exigem `automation:process`, `chat:read` e `crm:read`.

- **`automation_preflight_sync`** recebe `target`, `mode` e os opcionais `inboxIds` e `limits`. Retorna a identidade OAuth autenticada, modo efetivo da solicitação e modo/versão da política, allowlist efetiva, recorte solicitado/efetivo, limites e disponibilidade do SQLite e do lease. `ready_for_scope_check` autoriza prosseguir para a sondagem do alvo. `blocked` informa o motivo, incluindo infraestrutura indisponível, recorte inválido, `pending` ou solicitação de `apply` sob política incompatível. Consulta esquema e política do DO sem reservar lease, consumir orçamento Agendor, consultar mensagens ou alterar registros de negócio. O primeiro acesso a um DO pode inicializar a infraestrutura do runtime.
- **`automation_prepare_sync`** recebe os mesmos campos mais `requestId`. `inboxIds` ausente usa toda a interseção efetiva. Se informado, deve ser um subconjunto não vazio, mesmo para um alvo individual. Uma única caixa é permitida. A ausência de inbox canônico, um inbox fora do recorte ou uma recusa de escopo interrompe o processamento. Falhas temporárias podem retornar `deferred` antes das leituras sensíveis.
- **Limites** por conversa são `maxMessagePages` de 1 a 100 e `maxAttachmentPages` de 0 a 100, ambos com padrão 100. Zero pula a listagem de anexos, mas uma página de mensagens pode trazer referências de mídia. Retomadas aceitam apenas `requestId`, `workId`, `leaseToken` e `continuation`. Respeite `retryAt` quando informado. Alterar o recorte ou o limite requer um novo trabalho.
- **`automation_submit_analysis`** exige o lease, as versões atuais de snapshot e contexto e referências válidas. Grava análise e plano internamente. Em `preview`, as capacidades de escrita existentes na política não permitem despacho de automação. Pedidos de preparação em `apply` são recusados sob política `preview`. As ferramentas CRM diretas continuam autorizadas por escopos OAuth próprios. A concessão do piloto deve omitir `crm:write`, `crm:create`, `crm:enrich` e `automation:manage`.

## Limites da garantia

- A sondagem GET por conversa pode trazer mensagens embutidas no JSON de detalhe. O candidato descarta esses campos, sem interpretar, persistir ou devolver seu conteúdo. O contrato disponível ainda não comprova isolamento no transporte nem uma autorização atômica entre o detalhe e as rotas de conteúdo. Para a exigência de que bytes de inboxes externos sequer cheguem ao Worker, o piloto precisa de uma credencial Agendor restrita aos dois inboxes ou de uma rota de prova de escopo sem conteúdo, verificadas na conta de destino.
- A garantia do candidato cobre a preparação e suas retomadas. As ferramentas diretas de Chat são um caminho separado. A configuração de ferramentas permitidas no Zapia deve restringir a execução do piloto ao fluxo documentado. Um alvo de conversa limita as leituras Chat da preparação a esse ID. Registros e contexto CRM vinculados ao cliente continuam podendo ter histórico comercial anterior.
- Leases são por alvo lógico de trabalho. Um alvo `customer` e um alvo `conversation` têm chaves diferentes. Para o piloto, use exclusivamente `conversation`.
- Cobertura parcial de coleções continua explícita. O limite de saída MCP é 512 KiB. `ready` também pode produzir um plano em revisão quando faltar evidência.

## Evidências locais

| Verificação | Resultado |
|---|---|
| Suíte workerd, com contratos reais e arquivo E2E de apply excluídos | 610 testes em 43 arquivos |
| Suíte dirigida de escopo, estado, ingressos e executor, incluindo seleção por cliente com inbox misto | 115 testes em 5 arquivos |
| Seleção E2E de preview com SDK MCP e OAuth local | 10 passaram e 9 ficaram fora do recorte executado |
| TypeScript e bundle Wrangler em dry-run | Aprovados |

A suíte workerd e o ensaio SDK precisaram executar fora do sandbox para que o runtime e os arquivos temporários inicializassem. As fixtures e a rede simulada foram preservadas.

- Testes no workerd com SQLite e dados sintéticos cobrem persistência de trabalho, snapshot, manifesto, análise e plano após evicção. Incluem lease concorrente, expiração e renovação com fencing, CAS, idempotência de preparação e submissão, deduplicação de hints, retomada parcial e rejeição de versões e tokens desatualizados.
- Testes de escopo incluem os inboxes 4101 e 4102, inbox desconhecido, conflito entre campos, ID incorreto, tentativa de ampliar a allowlist, mudança de caixa durante uma continuação e replay pronto. As recusas são observadas antes das rotas de conteúdo ou CRM. Os testes de preview mantêm capacidades de escrita sintéticas e verificam ausência de operações/dispatch.
- O ensaio local autenticado com o cliente SDK MCP cobre preflight, recusa fora do recorte, preparação de uma conversa de 4102, limites de páginas e submissão em preview. Usa adaptadores mockados e bloqueia rede real. Os testes executados não invocam `automation_apply_plan`.

## Ensaio obrigatório pela conta do Zapia

1. Identifique a versão Cloudflare candidata e o endpoint usado pelo Zapia. Aprove uma conversa sintética em cada caixa permitida e um caso negativo controlado. O manifesto do repositório ainda não autoriza alvos de leitura real. Use a conexão OAuth do Zapia com os escopos mínimos de leitura e processamento. Confirme a política v6 em preview e o catálogo atualizado.
2. Chame `automation_preflight_sync` com este formato, substituindo o ID pelo alvo sintético aprovado. Repita para 4102. Registre apenas a versão da política, o modo, a identidade OAuth em forma redigida, o recorte, os limites e a disponibilidade de persistência e lease.

   ```json
   {
     "target": { "kind": "conversation", "conversationId": 101 },
     "mode": "preview",
     "inboxIds": [4101],
     "limits": { "maxMessagePages": 1, "maxAttachmentPages": 0 }
   }
   ```

3. Execute a preparação com os mesmos campos mais um `requestId` exclusivo. Respeite continuações vinculadas. Exija exatamente um par `conversationId/inboxId`, dentro do recorte, e confira a cobertura. Repita com o mesmo `requestId` para confirmar que a versão do trabalho se mantém enquanto o lease está vigente.
4. Repita a preparação para o caso negativo. Uma conversa sintética em 4102 com recorte `[4101]` comprova a recusa por recorte sem usar dados de um inbox externo. Para provar isolamento de um inbox externo, use uma fixture sintética autorizada pelo operador e a credencial/rota verificada do passo de isolamento. Um ID inexistente, isoladamente, comprova apenas o caminho de evidência ausente. Em todos os casos negativos, exija erro e ausência de chamadas de contato, mensagens, anexos e CRM, com contagens ou rotas redigidas do ambiente.
5. Submeta uma análise sintética baseada na versão retornada e depois tente uma versão antiga. Confirme o plano persistido e a rejeição da versão antiga. Compare as contagens de operações antes e depois, e confira ausência de POST/PATCH/PUT/DELETE no CRM. Registre identificadores técnicos redigidos e resultados. Preserve política e modo e descarte conteúdo, credenciais e tokens de lease dos logs.

O piloto supervisionado só pode ser liberado após evidência desses passos no cliente e ambiente usados pelo Zapia.
