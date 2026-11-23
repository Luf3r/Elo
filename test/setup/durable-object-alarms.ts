import { env, listDurableObjectIds, runInDurableObject } from 'cloudflare:test';
import { afterEach } from 'vitest';
import type { Env } from '../../src/env';

const testEnv: Env = env;

afterEach(async () => {
  // Queued or uncertain operations can schedule a maintenance alarm about one second later;
  // if it survives teardown, its queue consumer may log after the test environment is closing.
  const ids = await listDurableObjectIds(testEnv.AUTOMATION_STATE);
  for (const id of ids) {
    await runInDurableObject(testEnv.AUTOMATION_STATE.get(id), (_instance, ctx) => ctx.storage.deleteAlarm());
  }
});
