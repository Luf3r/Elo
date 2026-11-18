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

/** Read and parse a UTF-8 JSON file from disk. */
export function readJsonFile<T = unknown>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}
