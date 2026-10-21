import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: { bindings: {
      AGENDOR_CRM_TOKEN: 'unit-crm-token',
      MCP_TEST_TOKEN: 'unit-mcp-token',
    } },
  })],
  test: { testTimeout: 15_000, restoreMocks: true },
});
