# OAuth: ChatGPT Plus e Zapia

URL MCP: `https://elo-agendor-mcp.example.workers.dev/mcp`.

Use OAuth e Streamable HTTP. Ao conectar, revise o aplicativo e o destino de retorno na tela de consentimento. Permita somente quando tiver iniciado a conexão. Cloudflare Access envia o PIN para `owner@elo.example`; digite o PIN apenas na página Cloudflare. Não forneça token Agendor ou token de teste ao cliente MCP.

## Clientes

No ChatGPT, crie uma conexão MCP personalizada usando a URL acima e OAuth, quando essa opção estiver disponível na sua conta Plus. O registro do cliente pode usar CIMD ou DCR. A aplicação dispensa uma chave da API OpenAI. O nome e a localização do menu podem mudar; consulte o fluxo de conexão exibido na sua conta. Após instalar/conectar, selecione a integração em uma conversa normal.

No Zapia, use a opção de conectar servidor MCP informada pelo usuário, com a mesma URL e OAuth. Não inventar client IDs ou retornar a autenticação por token fixo: se o formulário pedir credenciais OAuth pré-registradas ou recusar o registro dinâmico, registrar os campos/erro concretos e cadastrar esse cliente pelo procedimento administrativo documentado da biblioteca.

Os clientes recebem concessões separadas. Teste em cada um: “Consulte as organizações do Agendor cujo nome começa com Elo.” Para tarefas, informe um `updatedDateGt` ISO 8601 nos últimos 31 dias.

No código local desta branch, as ferramentas declaram permissões separadas: `crm:read` para consultas CRM, `crm:write` para as quatro ferramentas de atualização limitadas e `chat:read` para futuras ferramentas somente de leitura do Agendor Chat. Solicite apenas os escopos necessários. A produção ainda não oferece os novos escopos; essa mudança está aguardando validação e confirmação antes do deploy.

## Recursos desta instalação

- Worker `elo-agendor-mcp`; conta Cloudflare `example-account-id`.
- Organização Zero Trust `example-team`, ativada pessoalmente pelo usuário.
- Access SaaS OIDC: `00000000-0000-0000-0000-000000000000`, nome `Elo Agendor MCP`.
- Política reutilizável `5ddae5ad-8ea8-434a-ad91-e5cc3d77dcc9`: Allow apenas o e-mail exato do proprietário.
- Callback OIDC exato: `https://elo-agendor-mcp.example.workers.dev/callback`.
- Scopes OIDC: `openid email`; PKCE ativado; modo sem client secret desativado.
- Somente One-time PIN selecionado para a aplicação; aceitar todos os provedores desativado.
- KV exclusivo `ELO_OAUTH_KV`, ID `00000000000000000000000000000000`, binding `OAUTH_KV`.
- Limitadores MCP1001, CRM1002 e OAuth1003. OAuth limita solicitações de login/registro por IP; o orçamento CRM permanece compartilhado entre aplicativos.

Os metadados públicos da aplicação Access foram consultados e correspondem a issuer, token, authorization e JWKS em `wrangler.jsonc`, com assinatura RS256. Client ID e endpoints são públicos; Client Secret é sigiloso.

## Credencial Access e publicação

Na [aplicação OIDC](https://dash.cloudflare.com/example-account-id/one/access-controls/apps/saas/00000000-0000-0000-0000-000000000000/edit), Application details contém Client secret e Reset secret. O proprietário gera a credencial e a salva em `ACCESS_CLIENT_SECRET` no `.dev.vars` ignorado. Não confundir essa credencial OIDC com o token do Agendor ou um token administrativo Cloudflare.

Depois de verificar a conta autenticada, executar:

```powershell
npm run typecheck
npm test
npm run test:scripts
npm run test:contract
npm run build
npm run oauth:stage-secret
npm run deploy
npm run verify:oauth
```

`oauth:stage-secret` transmite somente `ACCESS_CLIENT_SECRET` por stdin ao Wrangler, sem colocar valores em argumentos ou arquivos intermediários. Cria uma versão sem mudar o tráfego. O upload seguinte herda secrets da versão mais recentemente enviada, conforme a documentação Cloudflare. A publicação de código fica a cargo de `deploy`. Não publicar enquanto a política, os endpoints e o segredo não estiverem corretos.

## Verificação real pelo navegador

```powershell
npm run oauth:login
```

O processo cria um cliente público de verificação, callback em loopback e um arquivo ignorado `.tooling/oauth-login-url.txt`. Abra essa URL localmente, confira “Elo - verificação local”, permita e conclua o PIN por e-mail. O processo troca o código com PKCE e guarda a sessão em `.tooling/oauth-session.json`, sem exibir tokens. Não compartilhe esses arquivos. O link expira em 15 minutos.

Depois:

```powershell
npm run verify:mcp
```

O Inspector usa o access token OAuth somente em memória. Verifica saúde, rejeição de credenciais inválidas, oito ferramentas e quatro consultas CRM reais; nenhum conteúdo dos registros é exibido. `MCP_OAUTH_ACCESS_TOKEN` local pode substituir a sessão para diagnóstico, mas não há fallback para `MCP_TEST_TOKEN`. O verificador rejeita outro host remoto para não transmitir a credencial fora deste Worker.

## Expiração, revogação e rollback

Access tokens duram uma hora. Refresh tokens só são emitidos com consentimento `offline_access`; a concessão dura 35 dias a partir da autorização inicial. Renovar o access token não reinicia esse prazo; refaça a conexão quando a concessão expirar. Revogação via endpoint OAuth anunciado invalida a credencial correspondente segundo as garantias de KV; desconectar uma interface não prova, por si só, revogação no servidor.

Renove ou revogue concessões separadamente por aplicativo usando as APIs administrativas `OAuthHelpers` da biblioteca, exclusivamente por uma rotina administrativa local confiável; não existe endpoint administrativo público nesta aplicação. Para invalidar tudo em emergência, retire a publicação do endpoint ou restaure uma versão controlada enquanto administra as concessões. Não prometa revogação global instantânea com KV.

A versão anterior registrada é `7e6bdf1d-9f39-4435-959d-b000e1c0674f`, com autenticação de teste. Rollback restaura código e configuração e pode reativar aquela autenticação; faça-o conscientemente, com os secrets correspondentes. Recursos Access/KV e seus dados não são revertidos pelo rollback de código. Não ativar fallback automático para o token fixo quando OAuth falhar.

## Fontes

- [OpenAI: autenticação MCP](https://developers.openai.com/plugins/build/auth)
- [Cloudflare: Access para servidores MCP](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/)
- [Cloudflare: secrets e envio com código](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare: herança de bindings da versão mais recente](https://developers.cloudflare.com/workers/observability/errors/)
