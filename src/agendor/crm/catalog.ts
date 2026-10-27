import { z } from 'zod';
import { SafeError } from '../../errors';
import { normalizePage } from './pagination';
import { positiveId } from './schemas';
import type { CatalogCoverage, CatalogNamedEntry, CatalogPage, CatalogSnapshot, ConfigurationInput } from './types';

const named = z.object({ id: positiveId, name: z.string() });
const user = named.extend({ active: z.boolean().optional() });
const stage = named.extend({ sequence: z.number().int().nonnegative(), funnel: z.object({ id: positiveId }).optional() });
const field = z.object({ id: z.union([positiveId, z.string().min(1)]).optional(), name: z.string().optional(), type: z.string().optional(), options: z.array(z.unknown()).optional() }).passthrough();
const normalized = (value: string) => value.normalize('NFKC').trim().toLowerCase();
function validated<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Invalid upstream catalog record.', false);
  return result.data;
}

/** A prefix result is evidence only after equality of the returned normalized value. */
export function findExactEmail<T>(items: T[], email: string): T[] {
  const target = normalized(email);
  if (!target) return [];
  return items.filter(item => {
    const record = item as { contact?: { email?: unknown } | null } | null;
    const value = record?.contact?.email;
    return typeof value === 'string' && normalized(value) === target;
  });
}

/** Partial catalogs cannot establish uniqueness, even when one visible item matches. */
export function resolveUniqueCatalogName(items: CatalogNamedEntry[], name: string, coverage: CatalogCoverage): number | undefined {
  if (coverage.status !== 'complete' || !normalized(name)) return undefined;
  const matches = items.filter(item => normalized(item.name) === normalized(name));
  return matches.length === 1 ? matches[0]!.id : undefined;
}

export function normalizeCatalogPage(upstream: unknown, input: ConfigurationInput & { page: number; perPage: number }): CatalogPage {
  const page = normalizePage<Record<string, unknown>>(upstream, input.page, input.perPage);
  for (const item of page.items) {
    if (input.section === 'stages') {
      const value = validated(stage, item);
      if (value.funnel && value.funnel.id !== input.funnelId) throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Invalid upstream catalog scope.', false);
    } else if (input.section === 'customFields') validated(field, item);
    else if (input.section === 'users') validated(user, item);
    else validated(named, item);
  }
  return {
    ...page, section: input.section, fetchedAt: new Date().toISOString(),
    ...('entityType' in input ? { entityType: input.entityType } : {}),
    ...('funnelId' in input ? { funnelId: input.funnelId } : {}),
    ...('state' in input ? { state: input.state } : {}),
    // Missing next links and empty pages alone never prove catalog completeness.
    coverage: { status: 'partial', pages: [input.page] },
  };
}

/** Explicitly assemble already fetched pages; this helper performs no network traversal. */
export function createCatalogSnapshot(input: { accountId: string; pages: CatalogPage[] }): CatalogSnapshot {
  const snapshot: CatalogSnapshot = {
    version: crypto.randomUUID(), fetchedAt: new Date().toISOString(), accountId: input.accountId,
    funnels: [], stages: [], users: [], products: [], customFields: [],
    capabilities: { customFields: 'unverified', collectionWriteSemantics: 'unverified' }, coverage: {},
  };
  const timestamps = input.pages.map(page => Date.parse(page.fetchedAt));
  if (timestamps.some(time => !Number.isFinite(time))) throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Invalid catalog timestamp.', false);
  if (timestamps.length) snapshot.fetchedAt = new Date(Math.min(...timestamps)).toISOString();
  for (const page of input.pages) {
    const scope = page.entityType ?? page.funnelId ?? page.state;
    const key = scope === undefined ? page.section : `${page.section}:${scope}`;
    const prior = snapshot.coverage[key];
    snapshot.coverage[key] = { status: 'partial', pages: [...new Set([...(prior?.pages ?? []), ...page.coverage.pages])].sort((a, b) => a - b) };
    for (const item of page.items) {
      if (page.section === 'stages') {
        const value = validated(stage, item);
        const funnelId = value.funnel?.id ?? page.funnelId;
        if (funnelId === undefined) throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Missing catalog funnel scope.', false);
        const entry = { id: value.id, name: value.name, sequence: value.sequence, funnelId };
        if (!snapshot.stages.some(existing => existing.id === entry.id)) snapshot.stages.push(entry);
      } else if (page.section === 'customFields') {
        if (!page.entityType) throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Missing catalog entity scope.', false);
        snapshot.customFields.push({ ...validated(field, item), entityType: page.entityType });
      } else if (page.section === 'funnels' || page.section === 'users' || page.section === 'products') {
        const entry = page.section === 'users' ? validated(user, item) : validated(named, item);
        if (!snapshot[page.section].some(existing => existing.id === entry.id)) snapshot[page.section].push(entry);
      }
    }
  }
  return snapshot;
}

/** Owner-scoped cache; callers supply their own instance instead of a shared global. */
export class CatalogCache {
  private readonly entries = new Map<string, CatalogSnapshot>();
  set(snapshot: CatalogSnapshot): void { this.entries.set(snapshot.accountId, structuredClone(snapshot)); }
  get(accountId: string): CatalogSnapshot | undefined {
    const snapshot = this.entries.get(accountId);
    if (!snapshot) return undefined;
    const age = Date.now() - Date.parse(snapshot.fetchedAt);
    if (!Number.isFinite(age) || age < 0 || age >= 15 * 60 * 1000) { this.entries.delete(accountId); return undefined; }
    return structuredClone(snapshot);
  }
}
