import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
export const origin='https://elo-agendor-mcp.example.workers.dev';
export const resource=origin+'/mcp';
export const sessionPath='.tooling/oauth-session.json';
export function validateMcpTarget(value=resource){
  const url=new URL(value);
  assert(url.pathname==='/mcp' && !url.username && !url.password && !url.search && !url.hash,'Use an exact /mcp URL without credentials, query or fragment.');
  assert(url.origin===origin || (url.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)),'Only this production Worker or local HTTP is allowed.');
  return url;
}
export function readSession(){
  assert(existsSync(sessionPath),'Run npm run oauth:login and complete the browser login first.');
  const session=JSON.parse(readFileSync(sessionPath,'utf8'));
  assert(session.issuer===origin && session.resource===resource && typeof session.accessToken==='string' && session.expiresAt>Date.now(),'OAuth session expired or belongs to another resource. Sign in again.');
  return session;
}
