import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __ELO_DEPLOYMENT__: JSON.stringify({
      origin: 'https://elo-agendor-mcp.example.workers.dev',
      ownerEmail: 'owner@elo.example',
      tenantKey: 'elotenant',
      allowedInboxIds: [4101, 4102],
    }),
  },
  test: {
    include: [
      'test/domain/**/*.test.ts',
      'test/automation-planner.test.ts',
      'test/demand-resolution.test.ts',
      'test/stage-evidence.test.ts',
      'test/automation-scopes.test.ts',
      'test/automation-schemas.test.ts',
    ],
    environment: 'node',
    restoreMocks: true,
  },
});
