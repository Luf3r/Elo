export interface ToolContentPart {
  type: string;
  text?: string;
  mimeType?: string;
  data?: string;
  resource?: unknown;
}

export interface ToolCallResult {
  isError?: boolean;
  content?: ToolContentPart[];
  _meta?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcEnvelope<TResult = unknown> {
  jsonrpc?: string;
  id?: unknown;
  result?: TResult;
  error?: JsonRpcError;
}

export interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: {
    additionalProperties?: boolean;
    required?: string[];
    [key: string]: unknown;
  };
  annotations?: {
    readOnlyHint?: boolean;
    [key: string]: unknown;
  };
  _meta?: {
    securitySchemes?: Array<{ type: string; scopes?: string[] }>;
    [key: string]: unknown;
  };
}

export interface ToolListResult {
  tools: ToolDescriptor[];
}

export interface InitializeResult {
  serverInfo?: {
    name: string;
    version: string;
  };
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
}

export interface ToolErrorBody {
  error: {
    code: string;
    message?: string;
    status?: number;
    retryable?: boolean;
    requiredScope?: string;
  };
}

/** Parse JSON text into the requested test type without exposing `any`. */
export function parseJson<T = unknown>(text: string): T {
  const parsed: unknown = JSON.parse(text);
  return parsed as T;
}

function unwrapToolResult(source: ToolCallResult | JsonRpcEnvelope<ToolCallResult>): ToolCallResult | undefined {
  if ('content' in source) return source;
  if ('result' in source) return source.result;
  return undefined;
}

/** Extract the first text payload from an MCP tool result or JSON-RPC envelope. */
export function readToolText(source: ToolCallResult | JsonRpcEnvelope<ToolCallResult>): string {
  const text = unwrapToolResult(source)?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('Expected MCP tool result text content.');
  return text;
}

/** Parse the JSON text payload from an MCP tool result or JSON-RPC envelope. */
export function readToolJson<T = unknown>(source: ToolCallResult | JsonRpcEnvelope<ToolCallResult>): T {
  return parseJson<T>(readToolText(source));
}

/** Parse an HTTP Response body as typed JSON for test assertions. */
export async function readResponseJson<T = unknown>(response: Response): Promise<T> {
  return parseJson<T>(await response.text());
}
