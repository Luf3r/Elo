import { defineConfig } from 'vitest/config';

export default defineConfig({
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
