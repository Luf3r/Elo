import { z } from 'zod';

/** Thrown when serialized JSON fails syntax parsing or schema validation. */
export class CorruptedJsonError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CorruptedJsonError';
  }
}

/** Parse JSON text and validate the decoded value against a Zod schema. */
export function readJson<T extends z.ZodType>(schema: T, text: string, label?: string): z.output<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const prefix = label ? `Corrupted JSON (${label})` : 'Corrupted JSON';
    throw new CorruptedJsonError(`${prefix}: invalid JSON syntax (${detail}).`, { cause: error });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    const prefix = label ? `Corrupted JSON (${label})` : 'Corrupted JSON';
    throw new CorruptedJsonError(`${prefix}: schema validation failed (${issues}).`, { cause: parsed.error });
  }
  return parsed.data;
}
