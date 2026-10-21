import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';

function escape(value: string): string {
  return value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}
export function consentPage(details: ConsentDescription, handle: string): string {
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Autorizar acesso ao Agendor</title>
  <h1>Autorizar ${escape(details.clientName)}?</h1>
  <p>Este aplicativo poderá consultar pessoas, empresas, negócios e tarefas no Agendor. Acesso somente de leitura.</p>
  <p>${details.clientDomain ? `Domínio do aplicativo: <strong>${escape(details.clientDomain)}</strong>.` : 'O nome deste aplicativo foi informado por ele e não foi verificado.'}</p>
  <p>Destino da autorização: <strong>${escape(details.redirectHost)}</strong>.</p>
  ${details.redirectIsLoopback ? '<p>O destino é um aplicativo neste computador. Continue apenas se você iniciou esta conexão.</p>' : ''}
  <p>Permissões: ${details.scope.map(escape).join(', ')}.</p>
  ${details.scope.includes('offline_access') ? '<p>A conexão poderá ser renovada até a expiração ou revogação da autorização.</p>' : ''}
  <form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(handle)}"><button name="decision" value="approve">Permitir e entrar por e-mail</button> <button name="decision" value="deny">Negar</button></form></html>`;
}
