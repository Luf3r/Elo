import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson } from '../src/http';
import { SafeError } from '../src/errors';

afterEach(() => vi.unstubAllGlobals());
const request = () => new Request('https://api.agendor.com.br/v3/people');
describe('safe upstream HTTP', () => {
  it('parses successful JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ data: [] })),
    );
    expect(await fetchJson(request())).toEqual({ data: [] });
  });
  it.each([
    [401, 'UPSTREAM_UNAUTHORIZED', false],
    [403, 'UPSTREAM_FORBIDDEN', false],
    [404, 'UPSTREAM_NOT_FOUND', false],
    [429, 'UPSTREAM_RATE_LIMITED', true],
    [500, 'UPSTREAM_UNAVAILABLE', true],
    [503, 'UPSTREAM_UNAVAILABLE', true],
    [504, 'UPSTREAM_UNAVAILABLE', true],
  ])('maps %i without leaking raw errors', async (status, code, retryable) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('secret upstream body', { status: Number(status) })),
    );
    const error = await fetchJson(request()).catch((e) => e);
    expect(error).toMatchObject({ code, retryable, status });
    expect((error as Error).message).not.toContain('secret upstream body');
  });
  it('maps invalid successful JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('credential-bearing junk')),
    );
    await expect(fetchJson(request())).rejects.toMatchObject({ code: 'UPSTREAM_INVALID_RESPONSE' });
  });
  it('aborts a timed out request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (r: Request) =>
          new Promise((_resolve, reject) => {
            r.signal.addEventListener('abort', () => reject(r.signal.reason), { once: true });
          }),
      ),
    );
    await expect(fetchJson(request(), { timeoutMs: 5 })).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
      retryable: true,
    });
  });
  it('times out stalled response bodies too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (r: Request) =>
          new Response(
            new ReadableStream({
              start(controller) {
                r.signal.addEventListener('abort', () => controller.error(r.signal.reason));
              },
            }),
          ),
      ),
    );
    await expect(fetchJson(request(), { timeoutMs: 5 })).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
  });
  it('sanitizes network exceptions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('secret request headers');
      }),
    );
    await expect(fetchJson(request())).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });
  it('does not follow redirects carrying credentials', async () => {
    const fetch = vi.fn(async (r: Request) => {
      expect(r.redirect).toBe('manual');
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetch);
    await fetchJson(request());
  });
  it('does not dispatch a request that was already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn(async () => Response.json({}));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchJson(new Request(request(), { signal: controller.signal }))).rejects.toMatchObject({
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['fetch', 'body'])('propagates caller cancellation during %s consumption', async (phase) => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn((r: Request) =>
        phase === 'fetch'
          ? new Promise((_resolve, reject) => r.signal.addEventListener('abort', () => reject(r.signal.reason)))
          : Promise.resolve(
              new Response(
                new ReadableStream({
                  start(stream) {
                    r.signal.addEventListener('abort', () => stream.error(r.signal.reason));
                  },
                }),
              ),
            ),
      ),
    );
    setTimeout(() => controller.abort(), 5);
    await expect(
      fetchJson(new Request(request(), { signal: controller.signal }), { timeoutMs: 100 }),
    ).rejects.toMatchObject({ retryable: false });
  });
  it('rejects redirects without following their locations', async () => {
    const fetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'https://attacker.example' } }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(fetchJson(request())).rejects.toMatchObject({ code: 'UPSTREAM_INVALID_RESPONSE' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])('limits CRM JSON bodies to 1 MiB with declared length %s', async (declared) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: 'x'.repeat(1_048_576) }), {
            headers: declared ? { 'content-length': '1048590' } : {},
          }),
      ),
    );
    await expect(fetchJson(request())).rejects.toMatchObject({ code: 'UPSTREAM_INVALID_RESPONSE' });
  });
  it.each(['fetch', 'body'] as const)('enforces its deadline even when %s ignores AbortSignal', async (phase) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        phase === 'fetch'
          ? new Promise<Response>(() => {})
          : Promise.resolve(new Response(new ReadableStream({ start() {} }))),
      ),
    );
    await expect(fetchJson(request(), { timeoutMs: 5 })).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
  });
  it.each([
    ['12', 12],
    ['-1', undefined],
    ['secret-token', undefined],
    ['999999999', 86400],
  ])('sanitizes Retry-After %s', async (header, expected) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('secret', { status: 429, headers: { 'Retry-After': header as string } })),
    );
    const error = await fetchJson(request()).catch((e) => e);
    expect(error).toMatchObject({ code: 'UPSTREAM_RATE_LIMITED' });
    expect(error).toBeInstanceOf(SafeError);
    expect((error as SafeError).retryAfterSeconds).toBe(expected);
    expect(JSON.stringify(error)).not.toContain('secret');
  });
});
