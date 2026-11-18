# ADR-003: Integração Agendor Chat estritamente somente leitura

- **Status:** Aceito
- **Data:** 2026-10-22 (reforçada em 2026-10-28)

## Contexto

O propósito do servidor é ler atendimentos do Agendor Chat para produzir contexto comercial e cadastros/atualizações estruturados no Agendor CRM. A documentação pública da API do Agendor Chat (coleção Postman) não comprova semântica de paginação terminal em coleções nem assinatura verificável para webhooks, e o envio ou alteração de mensagens de atendimento envolve risco operacional direto com clientes finais.

## Decisão

Manter o adaptador e as ferramentas MCP do Agendor Chat estritamente **somente leitura** sob o escopo `chat:read`, restringindo as operações às rotas `GET` documentadas para a conta fixa (`7001`) e declarando cobertura parcial explicitamente sempre que o upstream não comprovar fim de paginação.

## Alternativas consideradas

- **Expor ferramentas de resposta, atribuição ou mudança de status no Chat:** ampliaria a superfície de risco para contato automático indevido com clientes finais e exigiria controles adicionais fora do escopo do projeto.
- **Inferir completude de coleções a partir de páginas curtas ou vazias:** rejeitado após validação real demonstrar variação entre chamadas sem `links.next`.

## Consequências

- Zero risco de o agente ou a automação enviar mensagens ou alterar o estado de conversas no Chat.
- Cobertura parcial de listagens e anexos é exposta como estado explícito aos clientes MCP, encaminhando casos sem evidência suficiente para revisão em vez de aplicar mudanças no CRM.
