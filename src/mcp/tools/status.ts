import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AuthContext } from '../../auth';
import { publicToolSecurity } from '../security';
import { jsonToolResult } from '../result';
import { TENANT_SERVICE_NAME } from '../../app/config/tenant';
import { COMMIT, VERSION } from '../../version';

export function registerStatus(server: McpServer, auth: AuthContext): void {
  server.registerTool(
    'server_status',
    {
      description: 'Read-only service health and authenticated client identity. Does not contact Agendor.',
      inputSchema: z.strictObject({}),
      _meta: publicToolSecurity,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      jsonToolResult({
        status: 'ok',
        service: TENANT_SERVICE_NAME,
        version: VERSION,
        commit: COMMIT,
        client: auth.clientId,
      }),
  );
}
