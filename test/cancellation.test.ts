import { afterEach, expect, it, vi } from 'vitest';
import { executeRead } from '../src/mcp/tools/read';
import { testEnv } from './helpers';

const auth = { clientId: 'test', scopes: ['crm:read'] };

afterEach(() => vi.unstubAllGlobals());
it('does not spend upstream quota or fetch for an already cancelled tool call', async () => {
  const controller = new AbortController();
  controller.abort();
  const env = testEnv();
  const fetch = vi.fn(async () => Response.json({ data: [] }));
  vi.stubGlobal('fetch', fetch);
  const result = await executeRead(env, auth, client => client.searchPeople({}), controller.signal);
  expect(result.isError).toBe(true);
  expect(env.AGENDOR_CRM_RATE_LIMITER.limit).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it('does not start a GET if cancellation occurs while awaiting the limiter', async () => {
  const controller = new AbortController();
  const env = testEnv({ AGENDOR_CRM_RATE_LIMITER: { limit: vi.fn(async () => { controller.abort(); return { success: true }; }) } });
  const fetch = vi.fn(async () => Response.json({ data: [] }));
  vi.stubGlobal('fetch', fetch);
  const result = await executeRead(env, auth, client => client.searchPeople({}), controller.signal);
  expect(result.isError).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
it('combines transport cancellation with tool cancellation through the CRM adapter', async () => {
  const controller = new AbortController();
  const observed = vi.fn();
  vi.stubGlobal('fetch', vi.fn((r: Request) => new Promise((_resolve, reject) => {
    r.signal.addEventListener('abort', () => { observed(); reject(r.signal.reason); });
  })));
  setTimeout(() => controller.abort(), 5);
  const result = await executeRead(testEnv(), auth, client => client.searchPeople({}), new AbortController().signal, controller.signal);
  expect(result.isError).toBe(true);
  expect(observed).toHaveBeenCalledOnce();
  expect(JSON.parse(result.content[0]!.text).error.retryable).toBe(false);
});
