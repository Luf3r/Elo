import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface CliArgSpec {
  flags?: readonly string[];
  options?: readonly string[];
  unknownOptionMessage?: string;
  missingValueMessage?: string;
}

export interface ParsedCliArgs {
  flags: Set<string>;
  values: Map<string, string>;
}

/** Return true when the current module is the Node CLI entrypoint. */
export function isEntrypoint(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return metaUrl === pathToFileURL(resolve(entry)).href;
}

/** Parse `--flag` booleans and `--option value` pairs strictly, rejecting unknown flags. */
export function parseCliArgs(argv: string[], spec: CliArgSpec): ParsedCliArgs {
  const knownFlags = new Set(spec.flags ?? []);
  const knownOptions = new Set(spec.options ?? []);
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const unknownMsg = spec.unknownOptionMessage ?? 'Unknown option.';
  const missingMsg = spec.missingValueMessage ?? 'Option requires a value.';

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    assert(token !== undefined && (knownFlags.has(token) || knownOptions.has(token)), unknownMsg);
    if (knownFlags.has(token)) {
      flags.add(token);
      continue;
    }
    const next = argv[i + 1];
    assert(next !== undefined && next.length > 0 && !next.startsWith('--'), missingMsg);
    values.set(token, next);
    i++;
  }

  return { flags, values };
}

/** Parse `.dev.vars` key-value lines into a map without mutating `process.env`. */
export function parseEnvVars(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2];
    if (key === undefined || value === undefined) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

/** Load local `.dev.vars` into `process.env` when present. */
export function loadLocalDevVars(filePath = '.dev.vars'): void {
  if (existsSync(filePath)) {
    process.loadEnvFile(filePath);
  }
}

/** Strip line/block comments and trailing commas outside string literals, then parse JSON. */
export function parseJsonc<T = unknown>(text: string): T {
  let withoutComments = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inString) {
      withoutComments += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      withoutComments += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      if (i < text.length) withoutComments += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    withoutComments += ch;
  }

  let cleaned = '';
  inString = false;
  escaped = false;
  for (let i = 0; i < withoutComments.length; i++) {
    const ch = withoutComments[i]!;
    if (inString) {
      cleaned += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      cleaned += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < withoutComments.length && /\s/.test(withoutComments[j]!)) j++;
      if (withoutComments[j] === '}' || withoutComments[j] === ']') continue;
    }
    cleaned += ch;
  }

  return JSON.parse(cleaned) as T;
}

/** Read and parse a UTF-8 JSON file from disk. */
export function readJsonFile<T = unknown>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

/** Read and parse a UTF-8 JSONC file from disk. */
export function readJsoncFile<T = unknown>(filePath: string): T {
  return parseJsonc<T>(readFileSync(filePath, 'utf8'));
}
