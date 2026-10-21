# Publicação Cloudflare

Estado anterior: **CRM com token de teste publicado e verificado em 2026-10-21**. A extensão OAuth está implementada e em publicação; o registro abaixo preserva a versão anterior para rollback. Consulte [OAuth](oauth-setup.md) para o novo fluxo. Não considerar o registro antigo como comprovação de OAuth em produção.

| Campo | Valor |
|---|---|
| Worker | `elo-agendor-mcp` |
| Conta | `owner@elo.example` |
| Base URL | https://elo-agendor-mcp.example.workers.dev |
| MCP Streamable HTTP | https://elo-agendor-mcp.example.workers.dev/mcp |
| Saúde pública | https://elo-agendor-mcp.example.workers.dev/health |
| Versão ativa | `7e6bdf1d-9f39-4435-959d-b000e1c0674f` |
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
