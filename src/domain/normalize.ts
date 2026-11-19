/** Normalize a person or organization name for comparison. */
export const normalizeName = (value: string): string =>
  value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');

/** Normalize an email address by trimming outer whitespace and lowercasing. */
export const normalizeEmail = (value: string): string => value.trim().toLowerCase();

/** Strip all non-digit characters from a document string while preserving digit order. */
export const normalizeDocument = (value: string): string => value.replace(/\D/g, '');
