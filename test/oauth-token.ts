import { getOAuthApi } from '@cloudflare/workers-oauth-provider';
import worker from '../src/index';
import { oauthOptions } from '../src/oauth/provider';
import { ORIGIN, RESOURCE } from '../src/oauth/config';
import { context, testEnv } from './helpers';
import { sha256 } from './oauth-helper';

export async function issueTestToken(
  env = testEnv(),
  props: Record<string, unknown> = { userId: 'owner-sub', email: 'owner@elo.example' },
  scopes = ['crm:read', 'offline_access'],
) {
  const api = getOAuthApi(oauthOptions, env);
  const client = await api.createClient({
    clientName: 'Unit client',
    redirectUris: ['https://client.example/callback'],
    tokenEndpointAuthMethod: 'none',
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
  });
  const verifier = 'integration-verifier-012345678901234567890123456789012345678901';
  const request = await api.parseAuthRequest(
    new Request(
      `${ORIGIN}/authorize?` +
        new URLSearchParams({
          client_id: client.clientId,
          response_type: 'code',
          redirect_uri: 'https://client.example/callback',
          resource: RESOURCE,
          scope: scopes.join(' '),
          code_challenge: await sha256(verifier),
          code_challenge_method: 'S256',
        }),
    ),
  );
  const { redirectTo } = await api.completeAuthorization({
    request,
    userId: 'owner-sub',
    scope: scopes,
    props,
    metadata: {},
  });
  const code = new URL(redirectTo).searchParams.get('code')!;
  const response = await worker.fetch(
    new Request(`${ORIGIN}/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.clientId,
        code,
        code_verifier: verifier,
        redirect_uri: 'https://client.example/callback',
        resource: RESOURCE,
      }),
    }),
    env,
    context(),
  );
  if (response.status !== 200) throw new Error('Test token issuance failed: ' + (await response.text()));
  return {
    ...((await response.json()) as { access_token: string; refresh_token?: string }),
    clientId: client.clientId,
  };
}
