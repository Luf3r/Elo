import { errorData, SafeError } from '../errors';

export function jsonToolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}
export function errorToolResult(error: unknown) {
  const result = { ...jsonToolResult({ error: errorData(error) }), isError: true as const };
  if (error instanceof SafeError && error.requiredScope) return { ...result, _meta: { 'mcp/www_authenticate': [`Bearer error=\"insufficient_scope\", scope=\"${error.requiredScope}\"`] } };
  return result;
}
