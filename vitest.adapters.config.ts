import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/reliability/**/*.test.ts'], environment: 'node', restoreMocks: true } });
