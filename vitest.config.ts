import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { configDefaults, defineConfig } from 'vitest/config';

const contract = process.env.RUN_AGENDOR_CONTRACT_TESTS === '1';

export default defineConfig({
  plugins: [cloudflareTest({
    // Use an isolated Wrangler config inside test/ for non-contract runs so
    // root .dev.vars is never loaded into the test worker and all synthetic
    // bindings come directly from test/wrangler.jsonc.
    wrangler: { configPath: contract ? './wrangler.jsonc' : './test/wrangler.jsonc' },
    ...(contract ? {
      miniflare: {
        kvNamespaces: ['OAUTH_KV'],
        bindings: {
          AGENDOR_CRM_TOKEN: process.env.AGENDOR_CRM_TOKEN ?? '',
          AGENDOR_CHAT_TOKEN: process.env.AGENDOR_CHAT_TOKEN ?? '',
          AGENDOR_CHAT_ACCOUNT_ID: process.env.AGENDOR_CHAT_ACCOUNT_ID ?? '',
          RUN_AGENDOR_CONTRACT_TESTS: '1',
        },
      },
    } : {}),
  })],
  // .agent-runs/ holds Contracanto worktrees (full repository copies); never collect their tests.
  test: { exclude: [...configDefaults.exclude, '.agent-runs/**', 'test/**/*.test.mjs'], testTimeout: 15_000, restoreMocks: true },
});
