import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AuthContext } from '../../auth';
import { jsonToolResult } from '../result';

export function registerStatus(server: McpServer, auth: AuthContext): void {
  server.registerTool('server_status', {
    description: 'Read-only service health and authenticated client identity. Does not contact Agendor.',
    inputSchema: z.strictObject({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => jsonToolResult({ status: 'ok', service: 'elo-agendor-mcp', version: '0.1.0', client: auth.clientId }));
}
