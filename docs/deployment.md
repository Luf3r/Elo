# Publicação Cloudflare

Estado atual: **OAuth publicado e validado em 2026-10-21**, versão `48f65d8d-d1b9-4d83-8102-e2f46f5b36e6`, no mesmo endpoint MCP. Secret Access preparado na versão não publicada `503a018c-7b45-4dc0-a66a-72235bbbc934` e herdado pelo upload de código, sem tráfego na versão intermediária. Descoberta de recurso/servidor, PKCE S256, CIMD e rejeição da autenticação fixa aprovados em produção. O proprietário concluiu o login real por PIN; o verificador trocou o código com PKCE sem expor credenciais.

Implementação: biblioteca OAuth oficial 1.2.3, jose 6.2.13, KV exclusivo e limitador OAuth1003; access token de 1h, renovação por 35d desde a autorização inicial somente com `offline_access`. Testes 139/139 no Workers, teste de proteção do verificador 1/1, contratos reais CRM 8/8 e JWKS Access 1/1, typecheck e build aprovados. Bundle 1529.69KiB/280.99KiB gzip; startup 58ms informado pelo Wrangler. Revisão independente com dois ajustes corrigidos e verificados.

O primeiro login encontrou uma incompatibilidade de runtime ao buscar as chaves de assinatura OIDC: Workers rejeita `redirect: 'error'`. A versão ativa usa `manual`, sem seguir redirecionamentos; a biblioteca exige resposta 200. Uma regressão unitária e um contrato com o JWKS real reproduziram o erro antes da correção e passaram depois. A validação de assinatura, issuer, audience, nonce e e-mail permanece obrigatória.

Inspector 2.11.0 com a sessão OAuth real: saúde, autenticação, oito ferramentas, `server_status` e quatro leituras CRM (pessoas, organizações, negócios e tarefas) aprovados. Tail durante essa execução: 18 eventos, sem os valores dos secrets, access/refresh tokens ou Authorization completo. Conteúdo CRM e frames brutos não foram exibidos nem gravados. A conexão dentro das interfaces do ChatGPT e Zapia ainda deve ser feita pelo proprietário; não foi testada nessas contas.

## Operação atual

Use os comandos e o procedimento de secrets em [OAuth](oauth-setup.md). Os secrets obrigatórios atuais são `AGENDOR_CRM_TOKEN` e `ACCESS_CLIENT_SECRET`. O token fixo antigo não autentica esta versão. Para o Inspector, conclua `npm run oauth:login` e execute `npm run verify:mcp`; a sessão fica apenas no arquivo local ignorado.

O Worker `elo-agendor-mcp` agora publica também as ferramentas somente leitura do Agendor Chat: `chat_list_conversations`, `chat_get_conversation` e `chat_list_messages`, protegidas pelo escopo `chat:read`. A versão 10 (`9a62a3b3-1750-484c-a811-6547efba2611`) está ativa em 100% do tráfego. O secret `AGENDOR_CHAT_TOKEN` e a variável `AGENDOR_CHAT_ACCOUNT_ID=7001` estão configurados na Cloudflare. Clientes conectados antes da concessão de `chat:read` podem precisar atualizar as ferramentas e reautorizar. Validação MCP autenticada em produção confirmou 15 ferramentas, quatro leituras CRM e chamada bem-sucedida de `chat_list_conversations`; conteúdo de conversas e mensagens não foi exibido. Nenhuma conversa ou registro CRM foi alterado durante a configuração.

## Histórico: publicação com token de teste

Consulte [OAuth](oauth-setup.md) para conectar clientes e operar o novo fluxo. O registro abaixo preserva a versão com token de teste anterior, para rollback; não é a versão ativa.

| Campo | Valor |
|---|---|
| Worker | `elo-agendor-mcp` |
| Conta | `owner@elo.example` |
| Base URL | https://elo-agendor-mcp.example.workers.dev |
| MCP Streamable HTTP | https://elo-agendor-mcp.example.workers.dev/mcp |
| Saúde pública | https://elo-agendor-mcp.example.workers.dev/health |
| Versão histórica | `7e6bdf1d-9f39-4435-959d-b000e1c0674f` |
| Publicação da versão | 2026-10-21 13:15 America/Cuiaba |
| Secrets confirmados | `AGENDOR_CRM_TOKEN`, `MCP_TEST_TOKEN`; valores omitidos |
| Namespace MCP / CRM | `1001` / `1002` |
| Chat | BLOCKED; sem ferramentas ou secret obrigatório |

O usuário autorizou explicitamente o envio dos dois tokens para Cloudflare Secrets e a publicação. Os valores foram transmitidos por stdin do Wrangler, sem arquivo intermediário ou valores em argumentos. A conta inicialmente devolveu erro10034 após a verificação do e-mail; uma nova tentativa liberou a criação do Worker. O subdomínio inicial `example.workers.dev` foi registrado pelo fluxo oficial do Wrangler. A primeira conexão TLS falhou durante a ativação do subdomínio; a repetição posterior passou, sem desativar verificações TLS.

## Evidências da versão publicada

- Instalação `npm ci` aprovada, sem vulnerabilidades no audit; 110 testes unitários/protocolo passando no workerd.
- Oito testes de contrato CRM reais passando, incluindo dados opcionais/nulos, paginação e tarefas por empresa. Contrato Chat explicitamente pulado pelo gate.
- TypeScript e bundle aprovados; upload de 1248.03 KiB / 216.40 KiB gzip; startup informado pelo Wrangler de 64ms.
- Inspector **2.11.0** em produção: saúde 200, Bearer ausente/incorreto 401, oito ferramentas em `tools/list`, `server_status` aprovado e quatro consultas reais de pessoas, empresas, negócios e tarefas aprovadas.
- Tail de produção durante a verificação: **20 eventos**, nenhum valor de segredo e nenhum Authorization completo encontrado. Conteúdo dos registros e frames brutos não foram exibidos nem salvos pelo verificador.
- Arquivos versionados, histórico Git e logs locais produzidos verificados sem os valores dos tokens; `.dev.vars` não versionado.
- Revisão independente concluída; cancelamento propagado até o upstream e coberto por regressões.

`/health` é liveness e não consulta Agendor. A URL MCP responde a clientes MCP autenticados; abrir o endereço no navegador sem Bearer retorna 401, como esperado.

## Procedimentos históricos da versão com token fixo

Os comandos abaixo descrevem a versão histórica e não configuram a publicação OAuth atual. Para a versão ativa, siga [OAuth](oauth-setup.md).

### Gate antes da publicação

```powershell
npm ci
npm run typecheck
npm test
npm run test:contract
npm run build
npm run cf:login
npm run cf:whoami
```

`cf:login` abre o fluxo oficial de autenticação da Cloudflare. Confirme a conta pretendida. Os namespaces nativos 1001 (MCP) e 1002 (CRM) precisam estar disponíveis; se usados por outro Worker, escolha outros inteiros positivos. Nenhum domínio, OAuth de clientes, banco, fila ou Durable Object da aplicação é necessário.

## Segredos e deploy

Configure secrets interativamente, sem valores nos argumentos:

```powershell
npx wrangler secret put AGENDOR_CRM_TOKEN
npx wrangler secret put MCP_TEST_TOKEN
npm run deploy
```

Use os valores guardados localmente, sem colá-los em documentação ou chat. `secrets.required` impede deploy sem os dois nomes. **Não** cadastre AGENDOR_CHAT_TOKEN enquanto o gate estiver bloqueado. `wrangler secret put` pode criar/publicar uma nova versão; trate a operação como alteração de produção.

Para repetir a verificação desta publicação no PowerShell:

```powershell
$env:MCP_URL = 'https://elo-agendor-mcp.example.workers.dev/mcp'
npm run verify:mcp
```

O token é lido do `.dev.vars`; não o passe em argumentos. A checagem precisa comprovar autenticação, descoberta, status e quatro leituras reais. `GET /health` precisa retornar 200 sem token; `/mcp` precisa rejeitar Bearer ausente e incorreto. Aguarde pelo menos dez segundos entre execuções para respeitar o orçamento CRM nativo de 4/10s.

Inspecione logs ao vivo em uma janela controlada e confirme ausência dos valores dos segredos e de Authorization completo. Não habilite logging de headers ou bodies para essa verificação. Registre data, versão implantada e resultados, sem conteúdo CRM.

## Rotação

1. Gere um novo token MCP com fonte criptográfica segura e guarde apenas em `.dev.vars` local.
2. Substitua `MCP_TEST_TOKEN` usando `wrangler secret put` com entrada interativa.
3. Atualize o cliente de teste autorizado.
4. Verifique o token novo com o Inspector.
5. Confirme que o token antigo recebe 401.

Para Agendor, obtenha novo token na conta e substitua `AGENDOR_CRM_TOKEN` pelo mesmo mecanismo. Não exige mudança de código. Para rollback de código use o histórico de versões do Wrangler, preservando o controle de rotação de secrets.
