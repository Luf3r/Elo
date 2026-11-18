import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Env } from '../../env';
import type { AuthContext } from '../../auth';
import {
  crmIdSchema,
  enrichOrganizationSchema,
  enrichPersonSchema,
  enrichDealSchema,
  updateTaskSchema,
} from '../../agendor/crm/mutation-schemas';
import { executeDirectCommand } from '../../automation/direct';
import { crmEnrichSecurity } from '../security';
import { writeAnnotations } from './read';
import { jsonToolResult, errorToolResult } from '../result';
export function registerCrmEnrich(server: McpServer, env: Env, auth: AuthContext, requestSignal?: AbortSignal) {
  for (const [name, patch] of [
    ['crm_enrich_organization', enrichOrganizationSchema],
    ['crm_enrich_person', enrichPersonSchema],
    ['crm_enrich_deal', enrichDealSchema],
    ['crm_update_task', updateTaskSchema],
  ] as const)
    server.registerTool(
      name,
      {
        description:
          'Enrich an exact existing CRM record with a non-empty allowlisted patch through the shared reserved executor. Requires requestId; another payload cannot reuse it. Catalog fields and relationships are verified, collection semantics may remain blocked, and uncertain outcomes require reconciliation.',
        inputSchema: z.strictObject({ requestId: z.string().trim().min(1).max(200), id: crmIdSchema, patch }),
        annotations: writeAnnotations,
        _meta: crmEnrichSecurity,
      },
      async (input, ctx) => {
        try {
          return jsonToolResult(
            await executeDirectCommand(
              env,
              auth,
              name,
              input,
              requestSignal ? AbortSignal.any([requestSignal, ctx.mcpReq.signal]) : ctx.mcpReq.signal,
            ),
          );
        } catch (error) {
          return errorToolResult(error);
        }
      },
    );
}
