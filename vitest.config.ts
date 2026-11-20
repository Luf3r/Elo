import { existsSync } from 'node:fs';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { configDefaults, defineConfig } from 'vitest/config';

const contract = process.env.RUN_AGENDOR_CONTRACT_TESTS === '1';
// Contract runs use the real local config; fresh clones only have the versioned example.
const contractConfig = existsSync('./wrangler.jsonc') ? './wrangler.jsonc' : './wrangler.example.jsonc';

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Use an isolated Wrangler config inside test/ for non-contract runs so
      // root .dev.vars is never loaded into the test worker and all synthetic
      // bindings come directly from test/wrangler.jsonc.
      wrangler: { configPath: contract ? contractConfig : './test/wrangler.jsonc' },
      ...(contract
        ? {
            miniflare: {
              kvNamespaces: ['OAUTH_KV'],
              bindings: {
                AGENDOR_CRM_TOKEN: process.env.AGENDOR_CRM_TOKEN ?? '',
                AGENDOR_CHAT_TOKEN: process.env.AGENDOR_CHAT_TOKEN ?? '',
                AGENDOR_CHAT_ACCOUNT_ID: process.env.AGENDOR_CHAT_ACCOUNT_ID ?? '',
                RUN_AGENDOR_CONTRACT_TESTS: '1',
              },
            },
          }
        : {}),
    }),
  ],
  // .agent-runs/ holds Contracanto worktrees (full repository copies); never collect their tests.
  test: {
    exclude: [...configDefaults.exclude, '.agent-runs/**', 'test/**/*.test.mjs'],
    testTimeout: 15_000,
    restoreMocks: true,
    coverage: {
      provider: 'istanbul',
      include: [
        'src/domain/**/*.ts',
        'src/automation/**/*.ts',
        'src/oauth/**/*.ts',
        'src/mcp/**/*.ts',
        'src/agendor/**/*.ts',
        'src/shared/**/*.ts',
      ],
      reporter: ['text', 'json-summary'],
      reportsDirectory: './dist/coverage',
      // Domain and automation floors sit one point below measured coverage.
      // OAuth, MCP, Agendor, and shared floors sit three points below the lowest
      // measured subdirectory because coverage varies more between Windows and Linux CI.
      thresholds: {
        'src/domain/**/*.ts': {
          statements: 86,
          branches: 79,
          functions: 90,
          lines: 89,
        },
        'src/automation/**/*.ts': {
          statements: 90,
          branches: 81,
          functions: 96,
          lines: 93,
        },
        'src/oauth/**/*.ts': {
          statements: 87,
          branches: 77,
          functions: 97,
          lines: 90,
        },
        'src/mcp/**/*.ts': {
          statements: 87,
          branches: 68,
          functions: 84,
          lines: 88,
        },
        'src/agendor/**/*.ts': {
          statements: 87,
          branches: 79,
          functions: 90,
          lines: 89,
        },
        'src/shared/**/*.ts': {
          statements: 88,
          branches: 80,
          functions: 85,
          lines: 89,
        },
      },
    },
  },
});
