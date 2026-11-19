import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { errorToolResult } from '../src/mcp/result';
import { BudgetDeferredError, SafeError } from '../src/shared/errors';
import { context, testEnv } from './helpers';

describe('HTTP and MCP entrypoint logging', () => {
  it('logs auth_service_unavailable with path and errorType without URL query on 503', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const env = testEnv({
      OAUTH_RATE_LIMITER: {
        limit: vi.fn(() =>
          Promise.reject(new TypeError('Rate limiter failed for alice@example.com Bearer tok_secret_123')),
        ),
      },
    });

    const response = await worker.fetch(
      new Request('https://example.com/authorize?token=secret-query-token&email=owner@example.com&code=12345678901'),
      env,
      context(),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Authentication service unavailable.',
    });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith({
      event: 'auth_service_unavailable',
      path: '/authorize',
      errorType: 'TypeError',
    });
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain('secret-query-token');
    expect(logged).not.toContain('owner@example.com');
    expect(logged).not.toContain('12345678901');
    expect(logged).not.toContain('alice@example.com');
    expect(logged).not.toContain('tok_secret_123');
    expect(logged).not.toContain('?');
  });

  it('logs auth_service_unavailable when OAuth config is unavailable and preserves 503 body', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const env = testEnv({ ACCESS_CLIENT_ID: '' });

    const response = await worker.fetch(
      new Request('https://example.com/token?client_secret=hidden-secret', { method: 'POST' }),
      env,
      context(),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Authentication service unavailable.',
    });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith({
      event: 'auth_service_unavailable',
      path: '/token',
      errorType: 'Error',
    });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('hidden-secret');
  });

  it('logs unexpected_error for non-SafeError in errorToolResult while keeping the result unchanged', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = errorToolResult(new RangeError('Sensitive payload for bob@example.com Bearer secret_tok'));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith({
      event: 'unexpected_error',
      errorType: 'RangeError',
    });
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain('bob@example.com');
    expect(logged).not.toContain('secret_tok');

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: {
              code: 'UPSTREAM_UNAVAILABLE',
              message: 'Service temporarily unavailable.',
              retryable: true,
              status: 503,
            },
          }),
        },
      ],
      isError: true,
    });
  });

  it('does not log anything for SafeError instances in errorToolResult and preserves _meta', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const scoped = errorToolResult(
      new SafeError('MCP_UNAUTHORIZED', 'Missing crm:write scope.', false, 403, 'crm:write'),
    );
    const deferred = errorToolResult(new BudgetDeferredError(Date.now() + 5000));

    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    expect(scoped).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: {
              code: 'MCP_UNAUTHORIZED',
              message: 'Missing crm:write scope.',
              retryable: false,
              status: 403,
              requiredScope: 'crm:write',
            },
          }),
        },
      ],
      isError: true,
      _meta: {
        'mcp/www_authenticate': ['Bearer error="insufficient_scope", scope="crm:write"'],
      },
    });

    expect(deferred).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: {
              code: 'UPSTREAM_RATE_LIMITED',
              message: 'Shared request budget reached. Retry later.',
              retryable: true,
              status: 429,
            },
          }),
        },
      ],
      isError: true,
    });
  });
});
