/// <reference types="vite/client" />
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Env } from '../src/env';
import { CorruptedJsonError, readJson } from '../src/shared/json';

const srcFiles = import.meta.glob<string>('../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('readJson', () => {
  const sampleSchema = z.strictObject({
    id: z.number().int().positive(),
    name: z.string().min(1),
  });

  it('parses valid JSON matching the Zod schema', () => {
    expect(readJson(sampleSchema, '{"id":42,"name":"Elo"}')).toEqual({ id: 42, name: 'Elo' });
  });

  it('throws CorruptedJsonError with explicit context on invalid JSON syntax', () => {
    expect(() => readJson(sampleSchema, '{corrupted', 'sample.row')).toThrow(CorruptedJsonError);
    expect(() => readJson(sampleSchema, '{corrupted', 'sample.row')).toThrow(
      /Corrupted JSON \(sample\.row\): invalid JSON syntax/,
    );
  });

  it('throws CorruptedJsonError with issue path on schema mismatch', () => {
    expect(() => readJson(sampleSchema, '{"id":-1,"name":""}', 'sample.row')).toThrow(CorruptedJsonError);
    expect(() => readJson(sampleSchema, '{"id":-1,"name":""}', 'sample.row')).toThrow(
      /Corrupted JSON \(sample\.row\): schema validation failed/,
    );
    expect(() => readJson(sampleSchema, '{"id":1,"name":"ok","extra":true}')).toThrow(/schema validation failed/);
  });

  it('fails explicitly when stored Durable Object rows contain corrupted JSON', async () => {
    const stub = (env as Env).AUTOMATION_STATE.get((env as Env).AUTOMATION_STATE.newUniqueId());
    await runInDurableObject(stub, async (instance, ctx) => {
      ctx.storage.sql.exec('INSERT INTO policy VALUES (1, 1, ?)', '{corrupted-policy');
      await expect(instance.getExecutionPolicy()).rejects.toThrow(/Corrupted JSON \(policy\.data\)/);

      ctx.storage.sql.exec('UPDATE policy SET data = ? WHERE singleton = 1', '{"version":1,"mode":"invalid"}');
      await expect(instance.getExecutionPolicy()).rejects.toThrow(/Corrupted JSON \(policy\.data\)/);
    });
  });

  it('forbids JSON.parse(...) as T casts in src/', () => {
    for (const [file, content] of Object.entries(srcFiles)) {
      expect(content, `${file} must use readJson instead of JSON.parse(...) as T`).not.toMatch(
        /\bJSON\.parse\s*\([\s\S]*?\)\s+as\b/,
      );
    }
  });
});
