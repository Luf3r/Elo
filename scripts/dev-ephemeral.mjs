import { unstable_dev } from 'wrangler';

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
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await worker.stop();
    process.exit();
  });
await worker.waitUntilExit();
