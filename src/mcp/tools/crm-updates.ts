import type { McpServer } from '@modelcontextprotocol/server';
import type { Env } from '../../env';
import type { AuthContext } from '../../auth';
import { crmWriteSecurity } from '../security';
import { updateIdInput, updateDealInput, updateDealStageInput, updatePersonInput, updateOrganizationInput } from '../../agendor/crm/schemas';
import { executeWrite, writeAnnotations } from './read';

const dealPatchInput = updateIdInput.extend({ patch: updateDealInput });
const dealStageInput = updateIdInput.extend({ patch: updateDealStageInput });
const personPatchInput = updateIdInput.extend({ patch: updatePersonInput });
const organizationPatchInput = updateIdInput.extend({ patch: updateOrganizationInput });

export function registerCrmUpdates(server: McpServer, env: Env, auth: AuthContext, signal?: AbortSignal): void {
  server.registerTool('crm_update_deal', {
    description: 'Update an existing deal title, value, description or ranking. Provide its exact ID and a non-empty patch. Cannot change owner, status, relationships or custom fields.',
    inputSchema: dealPatchInput, annotations: writeAnnotations, _meta: crmWriteSecurity,
  }, async ({ id, patch }, ctx) => executeWrite(env, auth, client => client.updateDeal(id, patch), ctx.mcpReq.signal, signal));

  server.registerTool('crm_update_deal_stage', {
    description: 'Move an existing deal to a stage sequence. Include funnel when the target stage belongs to a non-default funnel. Required fields are checked. Cannot change won/lost status.',
    inputSchema: dealStageInput, annotations: writeAnnotations, _meta: crmWriteSecurity,
  }, async ({ id, patch }, ctx) => executeWrite(env, auth, client => client.updateDealStage(id, patch), ctx.mcpReq.signal, signal));

  server.registerTool('crm_update_person', {
    description: 'Update allowlisted fields of an existing person: name, role, description, birthday, ranking, and email/work/mobile contact values. Provide an exact ID and non-empty patch.',
    inputSchema: personPatchInput, annotations: writeAnnotations, _meta: crmWriteSecurity,
  }, async ({ id, patch }, ctx) => executeWrite(env, auth, client => client.updatePerson(id, patch), ctx.mcpReq.signal, signal));

  server.registerTool('crm_update_organization', {
    description: 'Update allowlisted fields of an existing organization: name, legal name, description, website, ranking, and email/work/mobile contact values. Provide an exact ID and non-empty patch.',
    inputSchema: organizationPatchInput, annotations: writeAnnotations, _meta: crmWriteSecurity,
  }, async ({ id, patch }, ctx) => executeWrite(env, auth, client => client.updateOrganization(id, patch), ctx.mcpReq.signal, signal));
}
