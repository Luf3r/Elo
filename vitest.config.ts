import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const contract = process.env.RUN_AGENDOR_CONTRACT_TESTS === '1';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: { bindings: {
      AGENDOR_CRM_TOKEN: contract ? (process.env.AGENDOR_CRM_TOKEN ?? '') : 'unit-crm-token',
      MCP_TEST_TOKEN: 'unit-mcp-token',
      RUN_AGENDOR_CONTRACT_TESTS: contract ? '1' : '0',
    } },
  })],
  test: { testTimeout: 15_000, restoreMocks: true },
});
