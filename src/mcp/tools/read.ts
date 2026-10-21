import type { Env } from '../../env';
import { enforceCrmRateLimit } from '../../rate-limit';
import { jsonToolResult, errorToolResult } from '../result';
import { throwIfCancelled } from '../../cancellation';
import { createAgendorCrmClient } from '../../agendor/crm/client';
import type { AgendorCrmClient } from '../../agendor/crm/types';

export const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export async function executeRead(env: Env, read: (client: AgendorCrmClient) => Promise<unknown>, toolSignal?: AbortSignal, requestSignal?: AbortSignal): Promise<ReturnType<typeof jsonToolResult> & { isError?: boolean }> {
  const signals = [toolSignal, requestSignal].filter((s): s is AbortSignal => s !== undefined);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  try {
    throwIfCancelled(signal);
    await enforceCrmRateLimit(env);
    throwIfCancelled(signal);
    return jsonToolResult(await read(createAgendorCrmClient(env, { signal })));
  } catch (error) { return errorToolResult(error); }
}
