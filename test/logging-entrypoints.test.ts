import { describe, expect, it, vi } from 'vitest';
import { handleAutomationQueue } from '../src/automation/execution/queue';
import type { Env } from '../src/env';
import worker from '../src/index';
import { errorToolResult } from '../src/mcp/result';
import { RESOURCE } from '../src/oauth/config';
import { oauthOptions } from '../src/oauth/provider';
import { BudgetDeferredError, SafeError } from '../src/shared/errors';
import { context, testEnv } from './helpers';
import { issueTestToken } from './oauth-token';

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

  it('logs mcp_request_failed without message for unknown errors in /mcp and keeps 503 response', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const apiHandler = oauthOptions.apiHandler as ExportedHandler<Env>;
    const ctx = {
      ...context(),
      get auth() {
        throw new TypeError('Unexpected MCP failure for alice@example.com Bearer tok_secret_123');
      },
    } as unknown as ExecutionContext;

    const response = await apiHandler.fetch!(new Request(RESOURCE, { method: 'POST' }), testEnv(), ctx);

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: {
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Service temporarily unavailable.',
        retryable: true,
        status: 503,
      },
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith({
      event: 'mcp_request_failed',
      errorType: 'TypeError',
    });
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain('alice@example.com');
    expect(logged).not.toContain('tok_secret_123');
    expect(logged).not.toContain('Unexpected MCP failure');
  });

  it('does not log SafeError thrown in /mcp and preserves HTTP status and headers', async () => {
    const env = testEnv({ MCP_RATE_LIMITER: { limit: vi.fn(() => Promise.resolve({ success: false })) } });
    const token = await issueTestToken(env);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await worker.fetch(
      new Request(RESOURCE, { headers: { Authorization: `Bearer ${token.access_token}` } }),
      env,
      context(),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('10');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs queue_message_retry when queue processing fails before dead-letter threshold', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ack = vi.fn();
    const retry = vi.fn();

    await handleAutomationQueue(
      {
        messages: [
          {
            body: { accountKey: 'elotenant', operationId: 'op-retry-1', version: 1 },
            attempts: 1,
            ack,
            retry,
          },
        ],
      },
      testEnv(),
      () => {
        throw new TypeError('Queue failure for bob@example.com Bearer secret_tok');
      },
    );

    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    expect(ack).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith({
      event: 'queue_message_retry',
      attempts: 1,
      errorType: 'TypeError',
    });
    expect(errorSpy).not.toHaveBeenCalled();
    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).not.toContain('bob@example.com');
    expect(logged).not.toContain('secret_tok');
    expect(logged).not.toContain('Queue failure');
  });

  it('logs queue_message_dead_lettered on the fourth queue attempt', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ack = vi.fn();
    const retry = vi.fn();

    await handleAutomationQueue(
      {
        messages: [
          {
            body: { accountKey: 'elotenant', operationId: 'op-dlq-4', version: 1 },
            attempts: 4,
            ack,
            retry,
          },
        ],
      },
      testEnv(),
      () => {
        throw new RangeError('Dead-letter failure for carol@example.com 12345678901');
      },
    );

    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    expect(ack).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith({
      event: 'queue_message_dead_lettered',
      attempts: 4,
      errorType: 'RangeError',
    });
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain('carol@example.com');
    expect(logged).not.toContain('12345678901');
    expect(logged).not.toContain('Dead-letter failure');
  });

  it('logs watchdog_failed and propagates the error when scheduled maintainAccount fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('Watchdog DB failure for dave@example.com Bearer tok_watchdog');
    const env = testEnv({
      AUTOMATION_STATE: {
        getByName: () => ({
          maintainAccount: vi.fn(() => Promise.reject(failure)),
        }),
      } as unknown as Env['AUTOMATION_STATE'],
    });

    await expect(worker.scheduled({} as ScheduledController, env)).rejects.toBe(failure);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith({
      event: 'watchdog_failed',
      errorType: 'Error',
    });
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain('dave@example.com');
    expect(logged).not.toContain('tok_watchdog');
    expect(logged).not.toContain('Watchdog DB failure');
  });
});
