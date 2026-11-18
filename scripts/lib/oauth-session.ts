import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const origin = 'https://elo-agendor-mcp.example.workers.dev';
export const resource = `${origin}/mcp`;
export const sessionPath = '.tooling/oauth-session.json';
export const loginUrlPath = '.tooling/oauth-login-url.txt';

export interface OAuthSession {
  issuer: string;
  resource: string;
  clientId?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

/** Validate that the target URL points strictly to this Worker or a local HTTP `/mcp` endpoint. */
export function validateMcpTarget(value = resource): URL {
  const url = new URL(value);
  assert(
    url.pathname === '/mcp' && !url.username && !url.password && !url.search && !url.hash,
    'Use an exact /mcp URL without credentials, query or fragment.',
  );
  assert(
    url.origin === origin || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)),
    'Only this production Worker or local HTTP is allowed.',
  );
  return url;
}

function parseSessionObject(raw: unknown): OAuthSession {
  assert(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'Invalid OAuth session payload.');
  const candidate = raw as Record<string, unknown>;
  assert(typeof candidate.issuer === 'string', 'Invalid OAuth session issuer.');
  assert(typeof candidate.resource === 'string', 'Invalid OAuth session resource.');
  assert(typeof candidate.accessToken === 'string', 'Invalid OAuth session accessToken.');
  assert(
    typeof candidate.expiresAt === 'number' && Number.isFinite(candidate.expiresAt),
    'Invalid OAuth session expiry.',
  );
  assert(candidate.clientId === undefined || typeof candidate.clientId === 'string', 'Invalid OAuth session clientId.');
  assert(
    candidate.refreshToken === undefined || typeof candidate.refreshToken === 'string',
    'Invalid OAuth session refreshToken.',
  );
  return {
    issuer: candidate.issuer,
    resource: candidate.resource,
    clientId: candidate.clientId,
    accessToken: candidate.accessToken,
    refreshToken: candidate.refreshToken,
    expiresAt: candidate.expiresAt,
  };
}

/** Read a stored local OAuth session without enforcing access-token expiry (e.g. for refresh checks). */
export function readStoredSession(filePath = sessionPath): OAuthSession {
  assert(existsSync(filePath), 'Run npm run oauth:login and complete the browser login first.');
  return parseSessionObject(JSON.parse(readFileSync(filePath, 'utf8')));
}

/** Read the local OAuth session and assert it matches this resource and has not expired. */
export function readSession(filePath = sessionPath): OAuthSession {
  const session = readStoredSession(filePath);
  assert(
    session.issuer === origin &&
      session.resource === resource &&
      typeof session.accessToken === 'string' &&
      session.expiresAt > Date.now(),
    'OAuth session expired or belongs to another resource. Sign in again.',
  );
  return session;
}

/** Persist the local OAuth session file with owner-only permissions (`0o600`). */
export function writeSession(session: OAuthSession, filePath = sessionPath): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(session), { mode: 0o600 });
}

/** Persist the generated browser authorization URL locally with owner-only permissions (`0o600`). */
export function writeLoginUrl(url: string, filePath = loginUrlPath): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, url, { mode: 0o600 });
}

/** Read the locally stored OAuth authorization URL. */
export function readLoginUrl(filePath = loginUrlPath): string {
  return readFileSync(filePath, 'utf8').trim();
}
