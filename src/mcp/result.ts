import { errorData } from '../errors';

export function jsonToolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}
export function errorToolResult(error: unknown) {
  return { ...jsonToolResult({ error: errorData(error) }), isError: true };
}
