import { afterEach, expect, it, vi } from 'vitest';
import { executeRead } from '../src/mcp/tools/read';
import { testEnv, budgetMock } from './helpers';
import { readToolJson, type ToolErrorBody } from './helpers/json';

const auth = { clientId: 'test', scopes: ['crm:read'] };

afterEach(() => vi.unstubAllGlobals());
it('does not spend upstream quota or fetch for an already cancelled tool call', async () => {
  const controller = new AbortController();
  controller.abort();
  const env = testEnv();
  const fetch = vi.fn(async () => Response.json({ data: [] }));
  vi.stubGlobal('fetch', fetch);
  const result = await executeRead(env, auth, (client) => client.searchPeople({}), controller.signal);
  expect(result.isError).toBe(true);
  expect(budgetMock(env)).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it('does not start a GET if cancellation occurs while awaiting the limiter', async () => {
  const controller = new AbortController();
  const env = testEnv();
  budgetMock(env).mockImplementation(async () => {
    controller.abort();
    return { allowed: true, reservationId: 'cancelled' };
  });
  const fetch = vi.fn(async () => Response.json({ data: [] }));
  vi.stubGlobal('fetch', fetch);
  const result = await executeRead(env, auth, (client) => client.searchPeople({}), controller.signal);
  expect(result.isError).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
it('combines transport cancellation with tool cancellation through the CRM adapter', async () => {
  const controller = new AbortController();
  const observed = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (r: Request) =>
        new Promise((_resolve, reject) => {
          r.signal.addEventListener('abort', () => {
            observed();
            reject(r.signal.reason instanceof Error ? r.signal.reason : new Error(String(r.signal.reason)));
          });
          controller.abort();
        }),
    ),
  );

  const result = await executeRead(
    testEnv(),
    auth,
    (client) => client.searchPeople({}),
    new AbortController().signal,
    controller.signal,
  );
  expect(result.isError).toBe(true);
  expect(observed).toHaveBeenCalledOnce();
  expect(readToolJson<ToolErrorBody>(result).error.retryable).toBe(false);
});
