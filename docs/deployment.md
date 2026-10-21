# Publicação Cloudflare

Estado: **ainda não publicado**. Login oficial Cloudflare concluído e conta confirmada. O usuário autorizou explicitamente o envio de `AGENDOR_CRM_TOKEN` e `MCP_TEST_TOKEN` e a publicação do Worker. A tentativa de cadastro dos secrets foi bloqueada pela própria Cloudflare: **erro 10034, e-mail da conta ainda não verificado**. O Worker não foi criado e nenhum secret foi cadastrado. A autorização do usuário permanece válida para retomar após verificar o e-mail. Uma URL workers.dev só será registrada após deploy real; nenhuma URL foi inventada.

Para desbloquear: abra o [perfil Cloudflare](https://dash.cloudflare.com/profile), escolha **Send verification email** e confirme pelo link recebido no e-mail da conta. [Instruções oficiais](https://developers.cloudflare.com/fundamentals/user-profiles/verify-email-address/).

Verificação local em 2026-10-21: `npm ci` sem vulnerabilidades, 110 testes unitários/protocolo passando no workerd, oito testes de contrato CRM reais passando (Chat explicitamente pulado), TypeScript aprovado, bundle dry-run de aproximadamente 1245 KiB / 216 KiB gzip e Inspector 2.11.0 com oito tools, quatro consultas CRM reais e autenticação aprovada. Revisão independente concluída; cancelamento propagado até o upstream. Não há evidência de deploy ou logs de produção enquanto secrets e publicação não forem autorizados e executados.

## Gate antes da publicação

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

Após deploy, registre aqui a URL workers.dev real e a URL `/mcp`. O comando `npm run verify:mcp`, com `MCP_URL` apontando para essa URL e o token local correspondente, precisa passar para comprovar autenticação, descoberta, status e quatro leituras reais. `GET /health` precisa retornar 200 sem token; `/mcp` precisa rejeitar Bearer ausente e incorreto.

Inspecione logs ao vivo em uma janela controlada e confirme ausência dos valores dos segredos e de Authorization completo. Não habilite logging de headers ou bodies para essa verificação. Registre data, versão implantada e resultados, sem conteúdo CRM.

## Rotação

1. Gere um novo token MCP com fonte criptográfica segura e guarde apenas em `.dev.vars` local.
2. Substitua `MCP_TEST_TOKEN` usando `wrangler secret put` com entrada interativa.
3. Atualize o cliente de teste autorizado.
4. Verifique o token novo com o Inspector.
5. Confirme que o token antigo recebe 401.

Para Agendor, obtenha novo token na conta e substitua `AGENDOR_CRM_TOKEN` pelo mesmo mecanismo. Não exige mudança de código. Para rollback de código use o histórico de versões do Wrangler, preservando o controle de rotação de secrets.
