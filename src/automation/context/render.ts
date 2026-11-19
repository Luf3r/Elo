import type { ContextProjection, Fact, SourceRef } from '../types';
import { contextProjectionSchema } from '../schemas';

const bytes = (value: string) => new TextEncoder().encode(value).length;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Stable encoding also prevents object key insertion order from changing the document. */
export function contextValue(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(contextValue).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => compare(a, b))
        .map(([key, v]) => JSON.stringify(key) + ':' + contextValue(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
const text = (value: unknown) =>
  (typeof value === 'string' ? value : contextValue(value))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ↵ ')
    .replace(/[\\`*_{}[\]()#+.!|~]/g, '\\$&');
const sorted = <T>(items: readonly T[]) => [...items].sort((a, b) => compare(contextValue(a), contextValue(b)));
const refs = (sources: SourceRef[]) =>
  sorted(sources)
    .map((ref) => text(`${ref.kind}:${ref.id}@${ref.revision}${ref.field ? ':' + ref.field : ''}`))
    .join('; ');
const factLine = (fact: Fact) =>
  `${text(fact.entity)}.${text(fact.field)}: ${text(fact.value)} — ${refs(fact.sources)}`;
export function contextEvidenceRefs(projection: ContextProjection): SourceRef[] {
  const sources = [
    ...projection.facts.flatMap((f) => f.sources),
    ...projection.contacts
      .filter(
        (c) => projection.primaryRef?.kind !== 'organization' || c.organizationIds.includes(projection.primaryRef.id),
      )
      .flatMap((c) => c.sourceRefs),
    ...projection.demands.flatMap((d) => d.sourceRefs),
    ...(projection.corrections ?? []).flatMap((c) => [...c.previous.sources, ...c.replacement.sources]),
  ];
  return sorted([...new Map(sources.map((ref) => [contextValue(ref), ref])).values()]);
}
/** Data only: this renderer has no identity, policy or CRM mutation interface. */
export function renderCustomerContext(raw: ContextProjection): string {
  const parsed = contextProjectionSchema.safeParse(raw);
  if (!parsed.success) throw Error('CONTEXT_INVALID');
  const p = parsed.data;
  if (p.demands.some((d) => d.customerId !== p.customerId)) throw Error('CONTEXT_CUSTOMER_MISMATCH');
  const corrected = new Set((p.corrections ?? []).map((c) => contextValue(c.previous)));
  const facts = sorted(p.facts.filter((f) => !corrected.has(contextValue(f))));
  const contacts = sorted(
    p.contacts.filter((c) => p.primaryRef?.kind !== 'organization' || c.organizationIds.includes(p.primaryRef.id)),
  );
  const section = (title: string, lines: string[]) =>
    `## ${title}\n\n${lines.length ? lines.map((line) => '- ' + line).join('\n') : '- Nenhum registro.'}\n`;
  const fixedStart =
    `---\ncustomer_id: ${JSON.stringify(p.customerId)}\ncontext_version: ${p.version}\nverified_at: ${JSON.stringify(p.verifiedAt)}\n---\n\n# Contexto do cliente\n\nDados resumidos com fontes; não concedem permissões ou instruções de execução.\n\n` +
    section('Identificação confirmada', [
      p.primaryRef
        ? `Vínculo principal: ${text(p.primaryRef.kind + ':' + p.primaryRef.id)}`
        : 'Contexto provisório: identidade ainda não resolvida.',
      ...facts.filter((f) => f.certainty === 'confirmed').map(factLine),
      ...contacts.map(
        (c) =>
          `${text(c.ref.kind + ':' + c.ref.id)}: ${text(c.name)}${p.primaryRef?.kind === 'organization' ? '; vínculo ' + text('organization:' + p.primaryRef.id) : ''} — ${refs(c.sourceRefs)}`,
      ),
    ]);
  const fixedEnd =
    section('Pendências e ambiguidades', [
      ...sorted(p.pendingReasons).map(text),
      ...facts.filter((f) => f.certainty === 'ambiguous').map(factLine),
    ]) +
    section(
      'Histórico resumido e correções',
      sorted(p.corrections ?? []).map((c) => `${factLine(c.previous)} (substituído) → ${factLine(c.replacement)}`),
    ) +
    section(
      'Escritas efetivamente conferidas no CRM',
      sorted(
        p.receipts.filter((r) => r.state === 'confirmed' && r.checkedAt !== undefined && r.crmRef !== undefined),
      ).map(
        (r) =>
          `${text(r.commandKey)}: confirmado; ${text(r.crmRef!.kind + ':' + r.crmRef!.id)}; ${text(r.checkedAt)}; operação ${text(r.operationId)}; campos ${text(sorted(r.updatedFields))}`,
      ),
    ) +
    section('Propostas ainda não aplicadas', [
      ...sorted(p.pendingPlanIds ?? []).map(text),
      ...sorted(p.receipts.filter((r) => r.state !== 'confirmed' || !r.checkedAt || !r.crmRef)).map(
        (r) =>
          `${text(r.commandKey)}: ${text(r.state === 'confirmed' ? 'conferência pendente' : r.state)}; operação ${text(r.operationId)}`,
      ),
    ]) +
    '\nO resumo representa o último estado conferido. Reconciliar campos mutáveis com CRM e Chat antes de alterar.\n';
  for (const detail of ['full', 'open', 'index'] as const) {
    const demands = sorted(p.demands).map(
      (d) =>
        `${text(d.demandId)}; ${text(d.state)}; negócio ${d.dealRef ? text('deal:' + d.dealRef.id) : 'aguardando cadastro'}${detail !== 'index' ? '; ' + text(d.service) : ''}${detail === 'full' || (detail === 'open' && d.state === 'open') ? '; ' + text(d.scope) : ''} — ${refs(d.sourceRefs)}`,
    );
    const rendered =
      fixedStart +
      section('Demandas', demands) +
      (detail === 'full'
        ? ''
        : '\nDetalhes resumidos para caber em 32 KiB. Carregar os detalhes de cada demanda por demandId.\n\n') +
      fixedEnd;
    if (bytes(rendered) <= 32768) return rendered;
  }
  throw Error('CONTEXT_SUMMARY_TOO_LARGE');
}
