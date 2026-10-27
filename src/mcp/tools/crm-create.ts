import { z } from 'zod';
import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type { Env } from '../../env';
import type { AuthContext } from '../../auth';
import { createOrganizationSchema, createPersonSchema, createDealSchema, createTaskSchema } from '../../agendor/crm/mutation-schemas';
import { executeDirectCommand } from '../../automation/direct';
import { crmCreateSecurity } from '../security';
import { writeAnnotations } from './read';
import { jsonToolResult, errorToolResult } from '../result';
const requestId = z.string().trim().min(1).max(200);
export function registerCrmCreate(server: McpServer, env: Env, auth: AuthContext, requestSignal?: AbortSignal) {
  const configs: readonly [import('../../automation/direct').DirectToolName, StandardSchemaWithJSON, string][] = [
    ['crm_create_organization', z.strictObject({ requestId, record: createOrganizationSchema }), 'Create an organization'],
    ['crm_create_person', z.strictObject({ requestId, record: createPersonSchema }), 'Create a person'],
    ['crm_create_deal', createDealSchema.extend({ requestId }), 'Create a deal under one explicit organization/person'],
    ['crm_create_task', createTaskSchema.extend({ requestId }), 'Create a task under one explicit organization/person/deal'],
  ] as const;
  for (const [name, inputSchema, description] of configs) server.registerTool(name, { description: `${description} through a reserved typed command and read-back verification. requestId is required and cannot be reused with another payload. Returns operation receipts; uncertain writes require reconciliation. No arbitrary routes or account selection.`, inputSchema, annotations: writeAnnotations, _meta: crmCreateSecurity }, async (input, ctx) => {
    try { return jsonToolResult(await executeDirectCommand(env, auth, name, input, requestSignal ? AbortSignal.any([requestSignal, ctx.mcpReq.signal]) : ctx.mcpReq.signal)); } catch (error) { return errorToolResult(error); }
  });
}
