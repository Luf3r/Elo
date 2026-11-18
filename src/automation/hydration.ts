import type { ExecutionCommand } from './operations';
import { factSchema, dealSnapshotSchema } from './schemas';
import type {
  AutomationPolicy,
  CatalogSnapshot,
  DealSnapshot,
  DemandRecord,
  Fact,
  PreparedWork,
  SourceRef,
} from './types';

type RecordSnapshot = NonNullable<PreparedWork['snapshot']['records']>[number];
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const id = (value: unknown) => (typeof value === 'number' ? value : object(value).id);

/** Scalar projection of a freshly read canonical record. This never interprets
 * descriptions/Markdown as identity, stage evidence or authorization. */
function fields(raw: unknown, kind: RecordSnapshot['ref']['kind'], sources: SourceRef[]): Fact[] {
  const entity = kind === 'deal' ? 'demand' : kind;
  const record = object(raw);
  const contact = object(record.contact);
  const values = {
    ...record,
    ...(typeof contact.email === 'string' ? { email: contact.email } : {}),
    ...(typeof contact.mobile === 'string' ? { phone: contact.mobile } : {}),
  };
  return Object.entries(values).flatMap(([field, value]) => {
    const parsed = factSchema.safeParse({ entity, field, value, certainty: 'confirmed', sources });
    return parsed.success ? [parsed.data] : [];
  });
}

export async function hydrateRecord(
  raw: unknown,
  ref: RecordSnapshot['ref'],
  catalog: CatalogSnapshot,
  policy: AutomationPolicy,
  commands: ExecutionCommand[],
  demand?: DemandRecord,
): Promise<{ record: RecordSnapshot; source: SourceRef; deal?: DealSnapshot }> {
  const current = object(raw);
  if (current.id !== ref.id) throw Error('CRM_RECORD_UNVERIFIED');
  if (ref.kind !== 'deal' && (typeof current.name !== 'string' || !current.name.trim()))
    throw Error('CRM_IDENTITY_UNVERIFIED');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(raw)));
  const source: SourceRef = {
    kind: 'crm',
    id: `${ref.kind}:${ref.id}`,
    revision: [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join(''),
  };
  const written = new Map<string, Fact>();
  for (const ledger of [...commands].sort((a, b) =>
    (a.receipt.checkedAt ?? '').localeCompare(b.receipt.checkedAt ?? ''),
  )) {
    if (ledger.receipt.crmRef?.kind !== ref.kind || ledger.receipt.crmRef.id !== ref.id) continue;
    const command = ledger.command;
    for (const fact of fields(
      'payload' in command ? command.payload : 'patch' in command ? command.patch : {},
      ref.kind,
      command.sourceRefs,
    ))
      written.set(fact.field, fact);
  }
  const record = { ref, fields: fields(raw, ref.kind, [source]), lastWritten: [...written.values()] };
  if (ref.kind !== 'deal') return { record, source };
  const funnelId = id(current.funnel);
  const stage = object(current.dealStage);
  // Detail contracts may return a stage object or the supported sequence.
  const matches = catalog.stages.filter(
    (s) =>
      s.funnelId === funnelId &&
      (stage.id !== undefined ? s.id === stage.id : s.sequence === (stage.sequence ?? current.dealStage)),
  );
  const mapping =
    matches.length === 1
      ? policy.stageMapping.filter((m) => m.funnelId === funnelId && m.stageId === matches[0]!.id)
      : [];
  const statusId = id(current.dealStatus);
  const status = statusId === 1 ? 'open' : statusId === 2 ? 'won' : statusId === 3 ? 'lost' : current.status;
  const parsed = dealSnapshotSchema.safeParse({
    ...record,
    demandId: demand?.demandId,
    revision: source.revision,
    status,
    funnelId,
    stageId: matches[0]?.id,
    stage: mapping.length === 1 ? mapping[0]!.stage : undefined,
  });
  if (!parsed.success) throw Error('DEAL_STATE_UNVERIFIED');
  return { record, source, deal: parsed.data };
}
