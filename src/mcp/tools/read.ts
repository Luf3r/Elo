import type { Env } from '../../env';
import type { AuthContext } from '../../auth';
import { requireScope } from '../../auth';
import { jsonToolResult, errorToolResult } from '../result';
import { throwIfCancelled } from '../../cancellation';
import { createAgendorCrmClient } from '../../agendor/crm/client';
import type { AgendorCrmClient } from '../../agendor/crm/types';

export const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const writeAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
type ToolResult = ReturnType<typeof jsonToolResult> & { isError?: boolean; _meta?: Record<string, unknown> };
export async function executeRead(env: Env, auth: AuthContext, read: (client: AgendorCrmClient) => Promise<unknown>, toolSignal?: AbortSignal, requestSignal?: AbortSignal): Promise<ToolResult> {
  const signals = [toolSignal, requestSignal].filter((s): s is AbortSignal => s !== undefined);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  try {
    requireScope(auth, 'crm:read');
    throwIfCancelled(signal);
    return jsonToolResult(await read(createAgendorCrmClient(env, { signal })));
  } catch (error) { return errorToolResult(error); }
}
export async function executeWrite(env: Env, auth: AuthContext, write: (client: AgendorCrmClient) => Promise<unknown>, toolSignal?: AbortSignal, requestSignal?: AbortSignal): Promise<ToolResult> {
  const signals = [toolSignal, requestSignal].filter((s): s is AbortSignal => s !== undefined);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  try {
    requireScope(auth, 'crm:write');
    throwIfCancelled(signal);
    return jsonToolResult(await write(createAgendorCrmClient(env, { signal })));
  } catch (error) { return errorToolResult(error); }
}
