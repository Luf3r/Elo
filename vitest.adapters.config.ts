import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/reliability/**/*.test.ts'],
    setupFiles: ['test/reliability/deployment-setup.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});
