import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { configDefaults, defineConfig } from 'vitest/config';

const contract = process.env.RUN_AGENDOR_CONTRACT_TESTS === '1';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: { kvNamespaces: ['OAUTH_KV'], bindings: {
      AGENDOR_CRM_TOKEN: contract ? (process.env.AGENDOR_CRM_TOKEN ?? '') : 'unit-crm-token',
      AGENDOR_CHAT_TOKEN: contract ? (process.env.AGENDOR_CHAT_TOKEN ?? '') : '',
      AGENDOR_CHAT_ACCOUNT_ID: contract ? (process.env.AGENDOR_CHAT_ACCOUNT_ID ?? '') : '',
      MCP_TEST_TOKEN: 'unit-mcp-token',
      RUN_AGENDOR_CONTRACT_TESTS: contract ? '1' : '0',
    } },
  })],
  test: { exclude: [...configDefaults.exclude, 'test/**/*.test.mjs'], testTimeout: 15_000, restoreMocks: true },
});
