# OAuth para ChatGPT Plus e Zapia

Data: 2026-10-21. Estado: aprovado pelo usuário, implementado e publicado; validação final de login pelo proprietário em andamento. Evidências atuais em [publicação](../../deployment.md).

## Objetivo e decisões confirmadas

O usuário quer consultar o Agendor pelo ChatGPT Plus em conversas normais e pelo Zapia. Informou que o Zapia permite conectar um servidor MCP e aparentemente exige OAuth. Confirmou o uso de `owner@elo.example` para login por código enviado por e-mail, conforme a recomendação apresentada no chat.

A conexão será pessoal: somente esse endereço poderá autorizar aplicativos a consultar o CRM. A proposta preserva as oito ferramentas existentes e seu comportamento de leitura. O Agendor Chat continua bloqueado pelo contrato técnico ausente. O sucesso exige testar o fluxo OAuth e confirmar a conexão em cada aplicativo; documentação pública, isoladamente, não comprova a compatibilidade da interface disponível na conta do Zapia.

O plano original excluía OAuth e uso permanente do token de teste por clientes reais. Este documento propõe a extensão necessária; não altera o estado registrado da versão atualmente publicada.

## Opções consideradas

1. **Cloudflare Access com PIN por e-mail + biblioteca oficial OAuth no Worker — recomendada.** Aproveita a conta e a hospedagem existentes. Access comprova a identidade; o Worker emite credenciais próprias para cada cliente MCP. Acrescenta configuração de Access e armazenamento KV.
2. **Login Google ou GitHub + a mesma biblioteca OAuth.** Exige outro cadastro de aplicativo e a identificação da conta autorizada nesse provedor. Não corresponde à preferência de login por e-mail confirmada pelo usuário.
3. **Serviço de identidade externo.** Pode oferecer login por e-mail e gestão de sessões, mas acrescenta um fornecedor e configuração sem uma necessidade atual.

## Arquitetura proposta

Manter o Worker `elo-agendor-mcp`, na conta Cloudflare `example-account-id`, e o recurso canônico:

`https://elo-agendor-mcp.example.workers.dev/mcp`

Usar `@cloudflare/workers-oauth-provider`, em uma versão estável cuja API e disponibilidade serão verificadas antes da instalação. A documentação atual mantém `OAuthProvider` para um único Worker que reúne autorização e recurso. Essa forma evita acrescentar um segundo Worker e mantém a fábrica stateless `createMcpHandler` e o SDK MCP v2 existentes.

Adicionar um namespace KV exclusivo da aplicação, vinculado como `OAUTH_KV`, para os registros do provedor. Não armazenar dados CRM nesse namespace. Utilizar os helpers oficiais de consentimento e vínculo do fluxo ao navegador, sem criar um protocolo OAuth próprio.

Configurar uma aplicação Access for SaaS, OIDC, com callback exato:

`https://elo-agendor-mcp.example.workers.dev/callback`

Associar uma política reutilizável que permita exclusivamente `owner@elo.example`, com o provedor One-time PIN. O Worker também verifica a identidade assinada e o e-mail autorizado antes de emitir credenciais e a cada requisição MCP autenticada. Não aplicar uma tela de Access indiscriminadamente à URL inteira: descoberta OAuth e troca de tokens precisam permanecer acessíveis aos clientes conforme o protocolo.

## Fluxo de conexão

1. ChatGPT ou Zapia acessa `/mcp` e recebe um desafio OAuth com a URL dos metadados do recurso.
2. O cliente descobre o servidor de autorização e identifica seu aplicativo por CIMD ou registro dinâmico, conforme suporte real do cliente.
3. O navegador apresenta o nome do aplicativo, o destino do retorno e a permissão de leitura do CRM, com opções de permitir e negar. Os metadados do cliente são dados não confiáveis e devem ser escapados.
4. Após permitir, o navegador abre Cloudflare Access. O usuário comprova a posse do e-mail autorizado pelo PIN recebido.
5. O callback valida o vínculo ao navegador, o estado e a resposta OIDC antes de concluir a autorização MCP. A validação inclui assinatura, emissor, audiência, validade temporal e nonce, usando biblioteca de verificação estabelecida e chaves do provedor configurado.
6. O aplicativo troca o código de autorização por um token destinado exclusivamente ao recurso MCP. O Worker exige o escopo `crm:read` para listar ou executar ferramentas.
7. Se solicitado e autorizado, `offline_access` permite renovação. ChatGPT e Zapia recebem concessões independentes; revogar uma não deve revogar a outra. Reconexão e expiração devem ter instruções operacionais claras.

Nenhum PIN, token do Agendor ou token administrativo da Cloudflare será solicitado no chat. O usuário digita o PIN somente na página de login da Cloudflare.

## Contrato e controles

- Publicar metadados OAuth do recurso e do servidor de autorização, anunciando somente recursos, escopos, métodos de autenticação e mecanismos de registro implementados.
- Usar authorization code com PKCE S256, vínculo ao recurso canônico e correspondência estrita do callback registrado. Clientes sem PKCE S256 não serão aceitos para contornar incompatibilidades.
- Habilitar CIMD somente com a proteção de fetch público exigida pela biblioteca (`global_fetch_strictly_public`). Limitar registro dinâmico e rotas de autorização para reduzir abuso, separadamente do orçamento de consultas ao CRM.
- Usar helpers oficiais para consentimento, cookies seguros e estado com expiração. A implementação e os testes devem considerar que KV tem consistência eventual e não oferece exclusão atômica; não prometer revogação global instantânea ou consumo atômico de estado.
- Validar identidade e `crm:read` no servidor em todas as chamadas; declarar a exigência OAuth nos metadados das ferramentas compatíveis com o SDK instalado. Permitir somente `crm:read` e, quando solicitado, `offline_access`.
- Responder com 401 e descoberta OAuth para credenciais ausentes ou inválidas; distinguir escopo insuficiente com resposta OAuth apropriada. Falhas de Access, KV ou configuração não podem liberar consultas.
- Preservar validação de entrada, cancelamento, timeout, paginação explícita e limite compartilhado de consultas Agendor. Usar a identificação verificada do cliente no limite MCP, sem permitir que múltiplos clientes ampliem o orçamento CRM compartilhado.
- Manter o token `AGENDOR_CRM_TOKEN` apenas no Worker. Não repassar tokens upstream OIDC ao ChatGPT ou ao Zapia. Guardar somente os dados de identidade necessários nas propriedades das concessões; não guardar o PIN.
- Na versão de produção com OAuth ativo, `MCP_TEST_TOKEN` deixa de ser uma forma aceita de autenticar `/mcp`. O segredo pode ser preservado temporariamente para rollback controlado, mas não constitui fallback de produção. Adaptar a verificação operacional ao novo fluxo.
- Não registrar headers de autenticação, códigos, cookies, PINs, tokens ou conteúdo CRM. Erros apresentados ao cliente devem ser sanitizados; páginas de autorização e callback não devem ser cacheadas nem incorporadas em frames.

## Configuração e acesso à conta

Antes de criar recursos, inspecionar a organização Zero Trust, aplicações, políticas e provedores existentes, reutilizando somente configurações adequadas. O estado atual desses recursos ainda não foi consultado: as credenciais administrativas configuradas anteriormente foram limitadas a conta e Workers.

A configuração de Access requer permissões adicionais de administração de Access; KV também precisa de permissão apropriada. Preferir uma sessão já autenticada no painel ou um acesso administrativo restrito aos recursos necessários. Não ampliar silenciosamente os escopos do MCP administrativo instalado anteriormente. Se o painel exigir aceite de plano, pagamento ou outra decisão de conta, apresentar essa exigência concreta ao usuário.

Os endpoints OIDC, emissor e client ID serão obtidos da aplicação criada ou existente; não serão inferidos de um nome de organização. Guardar client secret e eventual material criptográfico em Cloudflare Secrets e nos arquivos locais ignorados quando necessários ao desenvolvimento. Variáveis não sigilosas e IDs de recursos podem ficar na configuração versionada. Nunca incluir valores de segredos no documento, Git, argumentos de processo ou logs.

## Organização da mudança

Separar roteamento do Worker, configuração do provedor OAuth, login OIDC e apresentação do consentimento. Atualizar `src/auth.ts` e `src/env.ts` para o contexto OAuth verificado, sem misturar a validação OIDC com os adaptadores Agendor. Preservar a fábrica MCP por requisição.

Atualizar configuração Wrangler, manifesto e lock npm, exemplos sem segredos, testes e documentação de conexão, renovação, revogação e rollback. Preservar os arquivos pnpm externos já presentes no workspace sem incorporá-los a essa alteração.

## Validação e implantação

Testar no runtime Workers: descoberta, desafio 401, escopos, PKCE, audiência/recurso, validação OIDC, e-mail diferente, consentimento negado, callbacks inválidos, vínculo ao navegador, expiração, renovação, revogação e falhas de configuração/KV. Cobrir isolamento entre clientes e rejeição do token fixo na configuração de produção. Usar respostas OIDC simuladas e assinadas nos testes, sem enviar PINs reais automaticamente.

Executar typecheck, testes relevantes e build. Manter as verificações existentes de leitura CRM e ausência de segredos. A prova OAuth deve incluir uma autorização real pelo navegador; se exigir PIN, o próprio usuário conclui essa etapa.

Antes de substituir a versão publicada, registrar a versão anterior, conferir o callback e a política restrita e validar os metadados e o fluxo em ambiente controlado. Depois do deploy, testar em produção a descoberta, autenticação, ferramentas e uma consulta autorizada. Confirmar separadamente a conexão no ChatGPT Plus e no Zapia e registrar qualquer incompatibilidade concreta; não declarar ambos conectados apenas com o teste do Inspector.

Rollback: restaurar a versão anterior registrada e sua configuração de autenticação, preservando os segredos necessários sem expor valores. A restauração é uma decisão operacional documentada, não um fallback automático acionado por falha OAuth. Não apagar recursos ou políticas preexistentes e não ampliar acesso a outros e-mails.

## Referências verificadas

- [OpenAI: autenticação de servidores MCP](https://developers.openai.com/plugins/build/auth)
- [Cloudflare: autorização MCP](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/)
- [Cloudflare: Access for SaaS para MCP, incluindo workers.dev e PIN](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/)
- [Biblioteca oficial OAuth: arquitetura e integração](https://github.com/cloudflare/workers-oauth-provider)
- [Helpers oficiais de login upstream e limitações de KV](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/upstream-sign-in.md)

## Revisão do documento

Verificado: objetivo e e-mail refletem as respostas do usuário; proposta distingue o estado publicado da extensão; contrato de clientes ainda exige teste real; configuração desconhecida é uma pré-condição explícita; rollback não libera acesso automaticamente. O documento não contém valores de credenciais nem propõe ferramentas de escrita no CRM.

Próxima etapa: revisão desta proposta pelo usuário, seguida do plano de implementação conforme o fluxo de planejamento aplicado à mudança de arquitetura.
