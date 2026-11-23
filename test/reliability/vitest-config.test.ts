import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const isWorkerd = 'WebSocketPair' in globalThis;

describe.skipIf(isWorkerd)('Workers Vitest configuration', () => {
  it('keeps unhandled errors visible and registers the Durable Object alarm cleanup', () => {
    const vitestConfig = readFileSync(resolve(process.cwd(), 'vitest.config.ts'), 'utf8');
    expect(vitestConfig).not.toContain('dangerouslyIgnoreUnhandledErrors');
    expect(vitestConfig).not.toContain('onUnhandledError');
    expect(vitestConfig).toContain("setupFiles: ['test/setup/durable-object-alarms.ts']");
  });
});
