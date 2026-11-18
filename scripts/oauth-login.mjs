import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { origin, resource, sessionPath } from './oauth-session.mjs';

const verifier = randomBytes(32).toString('base64url');
const state = randomBytes(32).toString('base64url');
let clientId,
  redirectUri,
  consumed = false;
async function jsonFetch(url, init) {
  const r = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  assert(r.ok, 'OAuth request failed; response content hidden.');
  return r.json();
}
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const supplied = Buffer.from(url.searchParams.get('state') ?? '');
    const expected = Buffer.from(state);
    if (
      req.method !== 'GET' ||
      url.pathname !== '/callback' ||
      consumed ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected) ||
      url.searchParams.get('iss') !== origin ||
      !url.searchParams.get('code')
    ) {
      res.writeHead(400);
      res.end('Retorno OAuth inválido.');
      return;
    }
    consumed = true;
    const token = await jsonFetch(origin + '/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: redirectUri,
        resource,
        code: url.searchParams.get('code'),
        code_verifier: verifier,
      }),
    });
    assert(typeof token.access_token === 'string' && Number.isFinite(token.expires_in), 'Invalid token response.');
    mkdirSync('.tooling', { recursive: true });
    writeFileSync(
      sessionPath,
      JSON.stringify({
        issuer: origin,
        resource,
        clientId,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + token.expires_in * 1000,
      }),
      { mode: 0o600 },
    );
    res.end('Login OAuth concluído. Pode voltar à conversa.');
    console.log('OAuth browser login PASS. Session stored in ignored local file; credentials hidden.');
    server.close();
  } catch {
    res.writeHead(502);
    res.end('Não foi possível concluir o login. Reinicie a verificação.');
    console.error('OAuth login failed; credentials and response content hidden.');
    server.close();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const metadata = await jsonFetch(origin + '/.well-known/oauth-authorization-server');
  assert(
    metadata.issuer === origin &&
      metadata.authorization_endpoint === origin + '/authorize' &&
      metadata.token_endpoint === origin + '/token' &&
      metadata.registration_endpoint === origin + '/register',
    'Unexpected OAuth endpoints.',
  );
  const client = await jsonFetch(metadata.registration_endpoint, {
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
  mkdirSync('.tooling', { recursive: true });
  writeFileSync('.tooling/oauth-login-url.txt', url.href, { mode: 0o600 });
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
