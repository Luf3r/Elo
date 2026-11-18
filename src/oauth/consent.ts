import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
export function consentPage(details: ConsentDescription, handle: string): string {
  const capabilities = details.scope
    .filter((scope) => scope !== 'offline_access')
    .map(
      (scope) =>
        ({
          'crm:read': 'consultar pessoas, empresas, negócios e tarefas no Agendor CRM',
          'chat:read': 'consultar conversas e mensagens do Agendor Chat',
          'crm:create': 'criar empresas, pessoas, negócios e tarefas no Agendor CRM',
          'crm:enrich': 'enriquecer campos e vínculos permitidos no Agendor CRM',
          'automation:read':
            'consultar o estado, operações e pendências da automação, com escopos de produto para contexto e revisões',
          'automation:process':
            'preparar e processar análises, com leituras e alterações CRM autorizadas separadamente',
          'automation:manage':
            'gerenciar políticas e decisões da automação, com alterações CRM autorizadas separadamente',
          'crm:write': 'atualizar campos permitidos de negócios, pessoas e empresas no Agendor CRM',
        })[scope] ?? 'acessar o Agendor',
    )
    .join('; ');
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Autorizar acesso ao Agendor</title>
  <h1>Autorizar ${escape(details.clientName)}?</h1>
  <p>Este aplicativo poderá ${escape(capabilities || 'consultar o estado do serviço')}. Ferramentas de leitura e atualização têm permissões separadas.</p>
  <p>${details.clientDomain ? `Domínio do aplicativo: <strong>${escape(details.clientDomain)}</strong>.` : 'O nome deste aplicativo foi informado por ele e não foi verificado.'}</p>
  <p>Destino da autorização: <strong>${escape(details.redirectHost)}</strong>.</p>
  ${details.redirectIsLoopback ? '<p>O destino é um aplicativo neste computador. Continue apenas se você iniciou esta conexão.</p>' : ''}
  <p>Permissões: ${details.scope.map(escape).join(', ')}.</p>
  ${details.scope.includes('offline_access') ? '<p>Ao permitir, você autoriza a renovação automática da conexão por até 35 dias a partir deste login. Cada token de acesso dura 24 horas. A renovação não amplia as permissões acima e termina se a autorização for revogada.</p>' : ''}
  <form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(handle)}"><button name="decision" value="approve">Permitir e entrar por e-mail</button> <button name="decision" value="deny">Negar</button></form></html>`;
}
