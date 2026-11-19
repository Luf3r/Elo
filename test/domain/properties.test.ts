import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { payloadDigest } from '../../src/automation/operations';
import { normalizedPhone } from '../../src/domain/identity-candidates';
import { normalizeDocument, normalizeEmail, normalizeName } from '../../src/domain/normalize';
import { canonical } from '../../src/shared/canonical';

const NUM_RUNS = 200;
const ASYNC_NUM_RUNS = 100;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function shuffleWithSeed(value: unknown, seed: number): { value: unknown; seed: number } {
  let state = seed >>> 0;
  const nextInt = (max: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % max;
  };
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(visit);
    }
    if (isPlainObject(node)) {
      const entries = Object.entries(node).map(([key, child]): [string, unknown] => [key, visit(child)]);
      for (let i = entries.length - 1; i > 0; i--) {
        const j = nextInt(i + 1);
        const current = entries[i]!;
        entries[i] = entries[j]!;
        entries[j] = current;
      }
      return Object.fromEntries(entries);
    }
    return node;
  };
  return { value: visit(value), seed: state };
}

function normalizeJsonValue(value: unknown): unknown {
  if (typeof value === 'number') {
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeJsonValue);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeJsonValue(v)]));
  }
  return value;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => jsonValuesEqual(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    return leftKeys.every((key) => Object.hasOwn(right, key) && jsonValuesEqual(left[key], right[key]));
  }
  return false;
}

const toggleAsciiCase = (value: string, mask: readonly boolean[]): string =>
  [...value]
    .map((char, index) => {
      if (char >= 'a' && char <= 'z') {
        return mask[index % mask.length] ? char.toUpperCase() : char;
      }
      if (char >= 'A' && char <= 'Z') {
        return mask[index % mask.length] ? char.toLowerCase() : char;
      }
      return char;
    })
    .join('');

const whitespacePadArb = fc
  .array(fc.constantFrom(' ', '\t', '\n', '\r'), { maxLength: 6 })
  .map((chars) => chars.join(''));

const digitCharArb = fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7', '8', '9');
const nonZeroDigitCharArb = fc.constantFrom('1', '2', '3', '4', '5', '6', '7', '8', '9');

const formattedPhoneArb = fc
  .tuple(
    nonZeroDigitCharArb,
    fc.array(digitCharArb, { minLength: 7, maxLength: 14 }),
    fc.array(fc.constantFrom('', ' ', '-', '.', '(', ')'), { minLength: 16, maxLength: 16 }),
    whitespacePadArb,
    whitespacePadArb,
  )
  .map(([firstDigit, restDigits, separators, lead, trail]) => {
    const body = [firstDigit, ...restDigits].map((digit, index) => `${separators[index] ?? ''}${digit}`).join('');
    return `${lead}+${body}${trail}`;
  });

const nonDigitStringArb = fc
  .string()
  .map((value) => value.replace(/\d/g, ''))
  .filter((value) => !/\d/.test(value));

describe('normalization property tests', () => {
  it('keeps normalizeName idempotent across ASCII and Unicode inputs', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.string({ unit: 'grapheme' })), (value) => {
        const once = normalizeName(value);
        expect(normalizeName(once)).toBe(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('keeps normalizeEmail idempotent', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.emailAddress()), (value) => {
        const once = normalizeEmail(value);
        expect(normalizeEmail(once)).toBe(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('keeps normalizeDocument idempotent', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const once = normalizeDocument(value);
        expect(normalizeDocument(once)).toBe(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('keeps normalizedPhone idempotent whenever defined', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), formattedPhoneArb), (value) => {
        const once = normalizedPhone(value);
        if (once !== undefined) {
          expect(normalizedPhone(once)).toBe(once);
        }
      }),
      { numRuns: NUM_RUNS },
    );

    fc.assert(
      fc.property(formattedPhoneArb, (value) => {
        const once = normalizedPhone(value);
        expect(once).toBeDefined();
        expect(normalizedPhone(once!)).toBe(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('makes normalizeEmail ignore ASCII case and outer whitespace', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.emailAddress()),
        whitespacePadArb,
        whitespacePadArb,
        fc.array(fc.boolean(), { minLength: 1, maxLength: 16 }),
        (value, lead, trail, mask) => {
          const varied = `${lead}${toggleAsciiCase(value, mask)}${trail}`;
          expect(normalizeEmail(varied)).toBe(normalizeEmail(value));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('makes normalizeDocument emit only digits and preserve digit order', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const normalized = normalizeDocument(value);
        const expectedDigits = [...value].filter((char) => char >= '0' && char <= '9').join('');
        expect(normalized).toMatch(/^\d*$/);
        expect(normalized).toBe(expectedDigits);
      }),
      { numRuns: NUM_RUNS },
    );

    fc.assert(
      fc.property(
        fc.array(fc.tuple(nonDigitStringArb, digitCharArb), { maxLength: 20 }),
        nonDigitStringArb,
        (pairs, suffix) => {
          const interleaved = pairs.map(([noise, digit]) => `${noise}${digit}`).join('') + suffix;
          const expectedDigits = pairs.map(([, digit]) => digit).join('');
          expect(normalizeDocument(interleaved)).toBe(expectedDigits);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('canonical and payloadDigest property tests', () => {
  it('produces identical canonical output for objects with the same keys in different order', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.integer(), (value, seed) => {
        const permuted = shuffleWithSeed(value, seed).value;
        expect(canonical(permuted)).toBe(canonical(value));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('produces distinct canonical output for distinct JSON values', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (rawLeft, rawRight) => {
        const left = normalizeJsonValue(rawLeft);
        const right = normalizeJsonValue(rawRight);
        fc.pre(!jsonValuesEqual(left, right));
        expect(canonical(left)).not.toBe(canonical(right));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('keeps payloadDigest deterministic and insensitive to object key order', async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), fc.integer(), async (value, seed) => {
        const permuted = shuffleWithSeed(value, seed).value;
        const first = await payloadDigest(value);
        const second = await payloadDigest(structuredClone(value));
        const reordered = await payloadDigest(permuted);
        expect(first).toMatch(/^[0-9a-f]{64}$/);
        expect(first).toBe(second);
        expect(reordered).toBe(first);
      }),
      { numRuns: ASYNC_NUM_RUNS },
    );
  });
});
