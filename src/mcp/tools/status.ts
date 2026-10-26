import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AuthContext } from '../../auth';
import { publicToolSecurity } from '../security';
import { jsonToolResult } from '../result';
import { VERSION } from '../../version';

export function registerStatus(server: McpServer, auth: AuthContext): void {
  server.registerTool('server_status', {
    description: 'Read-only service health and authenticated client identity. Does not contact Agendor.',
    inputSchema: z.strictObject({}),
    _meta: publicToolSecurity,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => jsonToolResult({ status: 'ok', service: 'elo-agendor-mcp', version: VERSION, client: auth.clientId }));
}
