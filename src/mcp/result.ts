import { errorData, SafeError } from '../shared/errors';
export const MAX_TOOL_OUTPUT_BYTES = 524_288;

export function jsonToolResult(value: unknown) {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).byteLength > MAX_TOOL_OUTPUT_BYTES)
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: {
              code: 'UPSTREAM_INVALID_RESPONSE',
              message: 'Response exceeded the bounded tool output; narrow the request.',
              retryable: false,
            },
          }),
        },
      ],
      isError: true as const,
    };
  return { content: [{ type: 'text' as const, text }] };
}
export function errorToolResult(error: unknown) {
  const result = { ...jsonToolResult({ error: errorData(error) }), isError: true as const };
  if (error instanceof SafeError && error.requiredScope)
    return {
      ...result,
      _meta: { 'mcp/www_authenticate': [`Bearer error=\"insufficient_scope\", scope=\"${error.requiredScope}\"`] },
    };
  return result;
}
