# ADR-006: Coexistência controlada com o criador nativo de Pessoa

- **Status:** Aceito
- **Data:** 2026-10-27 (reforçada em 2026-10-28)

## Contexto

A integração nativa existente entre Agendor Chat e Agendor CRM pode criar registros de Pessoa automaticamente e preencher o campo `crmPersonId` no contato do Chat. Como o Agendor CRM não fornece CAS condicional nem deduplicação atômica garantida contra uma criação concorrente externa, permitir que a automação crie Pessoas enquanto o criador nativo estiver ativo geraria registros duplicados.

## Decisão

1. Priorizar sempre o vínculo canônico `crmPersonId` obtido pela leitura individual do contato no Chat (`getContact`) antes de buscar ou inferir novos cadastros.
2. Bloquear o comando `create_person` no fluxo de automação (`authorizePlan` e `createQueueExecutionDeps.verify`) enquanto `policy.nativeCreatorDisabled` não for explicitamente `true`.
3. Enquanto o criador nativo permanecer ativo (`nativeCreatorDisabled: false`), a automação apenas reconcilia/enriquece Pessoas existentes e opera empresas, negócios e tarefas; suspeitas de duplicidade seguem para revisão humana (`review`) sem merge automático.

## Alternativas consideradas

- **Permitir `create_person` após busca por telefone/e-mail:** vulnerável a condição de corrida entre a busca e o `POST` quando a integração nativa cria a Pessoa no mesmo intervalo.
- **Merge automático de Pessoas duplicadas:** alto risco de corromper histórico comercial e vínculos de negócios no CRM.

## Consequências

- Elimina criações concorrentes de Pessoas pela automação enquanto a integração nativa estiver habilitada.
- Desbloquear `create_person` na automação exige comprovar e registrar operacionalmente que o criador nativo foi desativado antes de alterar `nativeCreatorDisabled` para `true` na política do DO.
- Ferramentas manuais (`crm_create_person`) continuam governadas por seu escopo OAuth próprio (`crm:create`) e `requestId`.
