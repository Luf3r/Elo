import { SafeError, type ErrorCode } from './errors';

export type LogLevel = 'info' | 'warn' | 'error';

export type ErrorLogFields = {
  errorType: string;
  code?: ErrorCode;
};

const SENSITIVE_FIELD_PATTERN = /(?:token|secret|authorization|password|cookie|email|phone|telefone|cpf|cnpj)/i;
const BEARER_TOKEN_PATTERN = /\bBearer\s+\S+/gi;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;
const LONG_DIGITS_PATTERN = /\d{11,}/g;
const ERROR_NAME_PATTERN = /^[A-Za-z]+Error$/;

function redactText(text: string): string {
  return text
    .replace(BEARER_TOKEN_PATTERN, '[redacted]')
    .replace(EMAIL_PATTERN, '[redacted]')
    .replace(LONG_DIGITS_PATTERN, '[redacted]');
}

function sanitizeField(key: string, value: unknown): unknown {
  if (SENSITIVE_FIELD_PATTERN.test(key)) {
    return '[redacted]';
  }
  if (value === null) {
    return null;
  }
  if (typeof value === 'object') {
    return '[omitted]';
  }
  if (typeof value === 'string') {
    return redactText(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return redactText(value.toString());
  }
  return '[omitted]';
}

function readErrorName(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const { name } = error;
    if (typeof name === 'string' && ERROR_NAME_PATTERN.test(name)) {
      return name;
    }
  }
  return 'Error';
}

/** Extract safe error metadata (`errorType` and optional `SafeError` code) without `message`. */
export function errorFields(error: unknown): ErrorLogFields {
  const errorType = readErrorName(error);
  if (error instanceof SafeError) {
    return { errorType, code: error.code };
  }
  return { errorType };
}

/** Emit a single structured object log entry for Workers Logs with automatic PII/secret redaction. */
export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const entry: Record<string, unknown> = { event };
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'event' || value === undefined) {
      continue;
    }
    entry[key] = sanitizeField(key, value);
  }
  if (level === 'info') {
    console.info(entry);
    return;
  }
  if (level === 'warn') {
    console.warn(entry);
    return;
  }
  console.error(entry);
}
