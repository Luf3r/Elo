# ADR-001: OAuth 2.1 no Worker com identidade via Cloudflare Access

- **Status:** Aceito
- **Data:** 2026-10-21 (renovação ajustada em 2026-11-06)

## Contexto

Clientes MCP externos (ChatGPT Plus e Zapia) precisam autenticar o proprietário sem receber o token da API do Agendor nem depender de um token estático compartilhado. Também era necessário emitir concessões independentes e revogáveis por cliente com PKCE e escopos granulares.

## Decisão

Adotar `@cloudflare/workers-oauth-provider` diretamente no Worker `elo-agendor-mcp`, usando `OAUTH_KV` para estado OAuth e delegando a autenticação humana para uma aplicação OIDC do **Cloudflare Access** (One-time PIN para o e-mail exato do proprietário). A verificação OIDC valida assinatura `RS256` via JWKS com `redirect: 'manual'`, `issuer`, `audience`, `nonce` e e-mail. Access tokens expiram em 24 horas e refresh tokens duram até 35 dias apenas com consentimento de `offline_access`.

## Alternativas consideradas

- **Provedor externo (Google/GitHub) ou terceiro serviço de identidade:** adicionaria dependência externa fora da conta Cloudflare já utilizada e não atenderia ao login por PIN no e-mail do proprietário.
- **Token fixo compartilhado (`MCP_TEST_TOKEN`):** impossibilitava revogação por cliente, escopos granulares e conformidade OAuth dos clientes MCP (removido em definitivo na Fase 5.1).

## Consequências

- Cada cliente MCP recebe `clientId` e concessão próprios, sem acesso às credenciais Agendor ou tokens OIDC upstream.
- `OAUTH_KV` oferece consistência eventual (revogação não é garantida como instantânea em todos os POPs).
- A desativação do CIMD (`clientIdMetadataDocumentEnabled: false`) exige que clientes usem o fluxo de registro dinâmico `/register`.
