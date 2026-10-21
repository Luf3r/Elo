import type { Env } from '../../env';
import { enforceCrmRateLimit } from '../../rate-limit';
import { jsonToolResult, errorToolResult } from '../result';

export const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export async function executeRead(env: Env, read: () => Promise<unknown>) {
  try {
    await enforceCrmRateLimit(env);
    return jsonToolResult(await read());
  } catch (error) { return errorToolResult(error); }
}
