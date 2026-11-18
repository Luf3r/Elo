import { unstable_dev } from 'wrangler';
import { isEntrypoint } from './lib/args.ts';

/** Start a local ephemeral Wrangler dev worker without persistent SQLite state. */
export async function startEphemeralDev(): Promise<void> {
  // Windows fallback for workerd SQLite persistence failures; production is unchanged.
  const worker = await unstable_dev('src/index.ts', {
    config: 'wrangler.jsonc',
    local: true,
    ip: '127.0.0.1',
    port: 8787,
    persist: false,
    logLevel: 'warn',
    experimental: { disableExperimentalWarning: true },
  });
  console.log(`Worker ready: http://${worker.address}:${worker.port}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void worker.stop().finally(() => {
        process.exit();
      });
    });
  }
  await worker.waitUntilExit();
}

if (isEntrypoint(import.meta.url)) {
  startEphemeralDev().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
