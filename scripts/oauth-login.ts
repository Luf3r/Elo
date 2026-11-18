import assert from 'node:assert/strict';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isEntrypoint } from './lib/args.ts';
import { origin, resource, writeLoginUrl, writeSession } from './lib/oauth-session.ts';

interface OAuthMetadata {
  issuer?: unknown;
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  registration_endpoint?: unknown;
}

interface DynamicClientRegistration {
  client_id?: unknown;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  assert(response.ok, 'OAuth request failed; response content hidden.');
  return await response.json<T>();
}

/** Run the interactive localhost OAuth PKCE browser login flow and save the local session. */
export async function runOauthLogin(): Promise<void> {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  let clientId = '';
  let redirectUri = '';
  let consumed = false;

  const handleCallback = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const encoder = new TextEncoder();
      const supplied = encoder.encode(url.searchParams.get('state') ?? '');
      const expected = encoder.encode(state);
      const code = url.searchParams.get('code');
      if (
        req.method !== 'GET' ||
        url.pathname !== '/callback' ||
        consumed ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected) ||
        url.searchParams.get('iss') !== origin ||
        !code
      ) {
        res.writeHead(400);
        res.end('Retorno OAuth inválido.');
        return;
      }
      consumed = true;
      const token = await jsonFetch<TokenResponse>(`${origin}/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          redirect_uri: redirectUri,
          resource,
          code,
          code_verifier: verifier,
        }),
      });
      assert(
        typeof token.access_token === 'string' &&
          typeof token.expires_in === 'number' &&
          Number.isFinite(token.expires_in),
        'Invalid token response.',
      );
      writeSession({
        issuer: origin,
        resource,
        clientId,
        accessToken: token.access_token,
        refreshToken: typeof token.refresh_token === 'string' ? token.refresh_token : undefined,
        expiresAt: Date.now() + token.expires_in * 1000,
      });
      res.end('Login OAuth concluído. Pode voltar à conversa.');
      console.log('OAuth browser login PASS. Session stored in ignored local file; credentials hidden.');
      server.close();
    } catch {
      res.writeHead(502);
      res.end('Não foi possível concluir o login. Reinicie a verificação.');
      console.error('OAuth login failed; credentials and response content hidden.');
      server.close();
    }
  };

  const server = createServer((req, res) => {
    void handleCallback(req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address() as AddressInfo | null;
    assert(address && typeof address.port === 'number', 'Local callback server failed to bind.');
    redirectUri = `http://127.0.0.1:${address.port}/callback`;
    const metadata = await jsonFetch<OAuthMetadata>(`${origin}/.well-known/oauth-authorization-server`);
    assert(
      metadata.issuer === origin &&
        metadata.authorization_endpoint === `${origin}/authorize` &&
        metadata.token_endpoint === `${origin}/token` &&
        metadata.registration_endpoint === `${origin}/register`,
      'Unexpected OAuth endpoints.',
    );
    const client = await jsonFetch<DynamicClientRegistration>(metadata.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Elo - verificação local',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert(typeof client.client_id === 'string', 'Invalid registration.');
    clientId = client.client_id;
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      resource,
      scope: 'crm:read chat:read offline_access',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    writeLoginUrl(url.href);
    console.log(
      'Browser authorization URL ready in .tooling/oauth-login-url.txt. Open locally and finish the email login; do not share the file.',
    );
    setTimeout(
      () => {
        console.error('Browser login expired. Run oauth:login again.');
        server.close();
      },
      15 * 60 * 1000,
    ).unref();
  } catch {
    server.close();
    console.error('Could not prepare OAuth login. Check deployment and discovery; no credential content displayed.');
    process.exitCode = 1;
  }
}

if (isEntrypoint(import.meta.url)) {
  void runOauthLogin();
}
