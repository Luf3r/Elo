import { describe, expect, it, vi } from 'vitest';
import { BudgetDeferredError, SafeError } from '../src/shared/errors';
import { errorFields, logEvent } from '../src/shared/logger';

describe('logEvent', () => {
  it.each([
    ['info', 'info'],
    ['warn', 'warn'],
    ['error', 'error'],
  ] as const)('logs a single object with event at %s level', (level, consoleMethod) => {
    const spy = vi.spyOn(console, consoleMethod).mockImplementation(() => undefined);
    logEvent(level, 'operation_checked', {
      requestId: 'req-123',
      operationId: 'op-456',
      status: 200,
      retryable: false,
      extra: null,
      ignored: undefined,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toHaveLength(1);
    const logged: unknown = spy.mock.calls[0]?.[0];
    expect(typeof logged).toBe('object');
    expect(logged).toEqual({
      event: 'operation_checked',
      requestId: 'req-123',
      operationId: 'op-456',
      status: 200,
      retryable: false,
      extra: null,
    });
  });

  it('logs only event when fields are omitted and preserves event over colliding field', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    logEvent('info', 'ping');
    logEvent('info', 'actual_event', { event: 'spoofed_event', requestId: 'req-1' });

    expect(spy.mock.calls[0]?.[0]).toEqual({ event: 'ping' });
    expect(spy.mock.calls[1]?.[0]).toEqual({ event: 'actual_event', requestId: 'req-1' });
  });

  it('redacts sensitive field names regardless of casing or value type', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    logEvent('warn', 'sensitive_fields', {
      accessToken: 'raw-token',
      CLIENT_SECRET: 'raw-secret',
      Authorization: 'raw-auth',
      userPassword: 'raw-password',
      sessionCookie: 'raw-cookie',
      ownerEmail: 'owner@example.com',
      customerPhone: 5511999998888,
      telefoneContato: '11999998888',
      cpf: '12345678901',
      CnpjEmpresa: { nested: '12345678000199' },
      safeField: 'kept',
    });

    expect(spy).toHaveBeenCalledWith({
      event: 'sensitive_fields',
      accessToken: '[redacted]',
      CLIENT_SECRET: '[redacted]',
      Authorization: '[redacted]',
      userPassword: '[redacted]',
      sessionCookie: '[redacted]',
      ownerEmail: '[redacted]',
      customerPhone: '[redacted]',
      telefoneContato: '[redacted]',
      cpf: '[redacted]',
      CnpjEmpresa: '[redacted]',
      safeField: 'kept',
    });
  });

  it('redacts emails, Bearer tokens, and 11+ digit sequences inside string values', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logEvent('error', 'pii_in_values', {
      contactAddress: 'alice.silva+crm@elo.example',
      detail: 'Failed for bob@example.org during sync',
      authHeader: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
      rawAuth: 'header: bearer tok_secret_123',
      documentA: '12345678901',
      documentB: '12345678000199',
      detailDigits: 'customer=5511987654321 failed',
      shortDigits: '1234567890',
      inboxId: '4101',
    });

    expect(spy).toHaveBeenCalledWith({
      event: 'pii_in_values',
      contactAddress: '[redacted]',
      detail: 'Failed for [redacted] during sync',
      authHeader: '[redacted]',
      rawAuth: 'header: [redacted]',
      documentA: '[redacted]',
      documentB: '[redacted]',
      detailDigits: 'customer=[redacted] failed',
      shortDigits: '1234567890',
      inboxId: '4101',
    });
  });

  it('replaces nested objects and arrays with [omitted]', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    logEvent('info', 'nested_values', {
      payload: { customer: 'alice@example.com' },
      items: ['a', 'b'],
      when: new Date('2026-11-19T12:00:00Z'),
      err: new Error('secret message'),
      empty: null,
    });

    expect(spy).toHaveBeenCalledWith({
      event: 'nested_values',
      payload: '[omitted]',
      items: '[omitted]',
      when: '[omitted]',
      err: '[omitted]',
      empty: null,
    });
  });
});

describe('errorFields', () => {
  it('returns errorType and code for SafeError without its message', () => {
    const err = new SafeError('UPSTREAM_TIMEOUT', 'Failed for alice@example.com with Bearer secret', true, 504);
    const fields = errorFields(err);

    expect(fields).toEqual({
      errorType: 'SafeError',
      code: 'UPSTREAM_TIMEOUT',
    });
    expect('message' in fields).toBe(false);
    expect(JSON.stringify(fields)).not.toContain('alice@example.com');
    expect(JSON.stringify(fields)).not.toContain('Bearer');
  });

  it('extracts code from SafeError subclasses', () => {
    const err = new BudgetDeferredError(Date.now() + 5000);
    expect(errorFields(err)).toEqual({
      errorType: 'SafeError',
      code: 'UPSTREAM_RATE_LIMITED',
    });
  });

  it('uses matching error name without code for standard and custom errors', () => {
    const typeErr = new TypeError('sensitive pii 12345678901');
    expect(errorFields(typeErr)).toMatchObject({ errorType: 'TypeError' });

    const customErr = Object.assign(new Error('private payload'), {
      name: 'CimdFetchError',
      code: 'SHOULD_NOT_LEAK',
    });
    expect(errorFields(customErr)).toMatchObject({ errorType: 'CimdFetchError' });
  });

  it('includes a redacted stack site without exposing the error message', () => {
    const err = new Error('private message alice@example.com');
    err.stack = `Error: ${err.message}\n    at ${'x'.repeat(240)} alice@example.com`;

    const fields = errorFields(err);

    expect(fields.errorSite).toHaveLength(200);
    expect(fields.errorSite).toMatch(/^at /);
    expect(JSON.stringify(fields)).not.toContain('private message');
    expect(JSON.stringify(fields)).not.toContain('alice@example.com');
    expect('message' in fields).toBe(false);
  });

  it('falls back to Error when name does not match /^[A-Za-z]+Error$/ or value is not an error object', () => {
    expect(errorFields(Object.assign(new Error('x'), { name: 'invalid_name' }))).toMatchObject({ errorType: 'Error' });
    expect(errorFields(Object.assign(new Error('x'), { name: '123Error' }))).toMatchObject({ errorType: 'Error' });
    expect(errorFields(Object.assign(new Error('x'), { name: 'CustomFailure' }))).toMatchObject({ errorType: 'Error' });
    expect(errorFields('raw secret string')).toEqual({ errorType: 'Error' });
    expect(errorFields(null)).toEqual({ errorType: 'Error' });
  });
});
