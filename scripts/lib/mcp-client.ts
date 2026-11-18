import assert from 'node:assert/strict';

export interface McpTextContent {
  type?: string;
  text?: string;
}

export interface McpToolCallResult {
  isError?: boolean;
  error?: { code?: string };
  content?: McpTextContent[];
  [key: string]: unknown;
}

export interface McpClientOptions {
  target: URL;
  accessToken: string;
  clientName: string;
  clientVersion?: string;
}

export type McpToolCaller = (name: string, args?: Record<string, unknown>) => Promise<McpToolCallResult>;

/** Connect a Bearer-authenticated Streamable HTTP MCP client and close it cleanly afterward. */
export async function withMcpClient<T>(
  options: McpClientOptions,
  run: (callTool: McpToolCaller) => Promise<T>,
): Promise<T> {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: options.clientName, version: options.clientVersion ?? '1.0.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(options.target, {
        requestInit: {
          headers: { Authorization: `Bearer ${options.accessToken}` },
          redirect: 'error',
        },
      }),
    );
    return await run(async (name, arguments_) => {
      return await client.callTool({ name, arguments: arguments_ });
    });
  } finally {
    await client.close();
  }
}

/** Probe `/health` for a target URL or origin without following redirects. */
export async function probeHealth(baseOriginOrTarget: string | URL, timeoutMs = 15_000): Promise<Response> {
  return fetch(new URL('/health', baseOriginOrTarget), {
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export interface UnauthorizedProbeOptions {
  method?: 'GET' | 'POST';
  body?: string;
  requireWwwAuthenticate?: boolean;
  timeoutMs?: number;
}

/** Assert that unauthenticated or invalid-token requests to `/mcp` fail closed with HTTP 401. */
export async function assertUnauthorizedMcpRequests(
  target: string | URL,
  headersList: Array<Record<string, string>> = [{}, { Authorization: 'Bearer intentionally-invalid-token' }],
  options: UnauthorizedProbeOptions = {},
): Promise<void> {
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? 15_000;
  for (const extraHeaders of headersList) {
    const headers: Record<string, string> =
      options.body !== undefined ? { 'Content-Type': 'application/json', ...extraHeaders } : { ...extraHeaders };
    const response = await fetch(target, {
      method,
      headers,
      body: options.body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    assert.equal(response.status, 401);
    if (options.requireWwwAuthenticate) {
      assert(response.headers.get('www-authenticate')?.includes('resource_metadata='));
    }
    await response.body?.cancel();
  }
}
