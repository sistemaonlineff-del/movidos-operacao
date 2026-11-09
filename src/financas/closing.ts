import { parseDate, parseMoney, validateState } from './domain';
import type { FinancialState, Identity, Plan, Transaction } from './domain';

type SavedRow = Record<string, unknown>;
export type ClosingKind = 'talitaJorge' | 'invoice';
export type ClosingSource = {
  key: string; kind: ClosingKind; table: 'financial_views' | 'financial_periods'; recordId: string;
  viewId: string; title: string; period: string; partner: string; reference: string;
  field: string; cents: number | null; savedDate: string; issue: string; fingerprint: string; slots: string[];
};
export type ClosingChoice = {
  key: string; fingerprint: string; destination: 'empresa' | 'pessoal' | ''; date: string;
  category: string; subcategory: string; detail: string; mode: 'planning' | 'cash';
  cashAcknowledged: boolean; overlapAcknowledged: boolean;
  tax?: { rate: string; base: string; basis: 'source' | 'manual'; category: string; subcategory: string; post: boolean; paidAcknowledged: boolean };
};
type Link = {
  version: 1; key: string; slots: string[]; snapshot: ClosingSource; destination: string;
  date: string; mode: string; tax: null | { rate: string; basis: string; base: number; cents: number };
  taxEntry: boolean; reversalOf?: string;
};
const prefix = 'movidos-closing:v1:';
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const record = (value: unknown): SavedRow => value && typeof value === 'object' && !Array.isArray(value) ? value as SavedRow : {};
const unique = (values: string[]) => [...new Set(values)].sort();
const id = (table: string, recordId: string, kind: string) => `closing:${JSON.stringify([table, recordId, kind])}`;
const slot = (table: string, recordId: string, kind: string) => `${table === 'financial_views' ? 'v' : 'p'}:${recordId}:${kind === 'invoice' ? 'nf' : 'tj'}`;

function notes(value: unknown): SavedRow {
  if (typeof value !== 'string') return record(value);
  try { return record(JSON.parse(value)); } catch { return {}; }
}
function savedMoney(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(String(value))) return null;
  try { return parseMoney(String(value)); } catch { return null; }
}

export function closingSources(views: SavedRow[], periods: SavedRow[]): ClosingSource[] {
  const result: ClosingSource[] = [];
  const activePeriods = periods.filter(row => row.is_active !== false);
  for (const view of views.filter(row => row.is_active !== false && text(row.id))) {
    const linked = activePeriods.filter(row => row.financial_view_id === view.id).sort((left, right) => text(left.id).localeCompare(text(right.id)));
    const summary = record(notes(view.notes).summary);
    const labels = unique(linked.map(row => text(row.label)));
    const partners = unique(linked.map(row => text(row.logistics_partner) || text(row.partner)));
    const references = unique(linked.map(row => text(row.reference_cnpj)));
    const scoped = linked.length > 0 && labels.length === 1 && !!labels[0] && partners.length === 1 && !!partners[0] && references.length === 1 && !!references[0];
    const scopeIssue = !scoped ? 'Resumo sem vinculo unico de periodo, parceiro e CNPJ. Conferencia manual na origem necessaria.' : text(summary.period) && text(summary.period) !== labels[0] ? 'Periodo do resumo diverge do fechamento salvo.' : '';
    const make = (kind: ClosingKind, row: SavedRow, table: ClosingSource['table'], field: string, value: unknown, issue: string, slots: string[], rawDate: unknown): ClosingSource => {
      const cents = savedMoney(value);
      const source = {
        key: id(table, text(row.id), kind), kind, table, recordId: text(row.id), viewId: text(view.id), title: text(view.title),
        period: table === 'financial_periods' ? text(row.label) : labels.join(' / '),
        partner: table === 'financial_periods' ? text(row.logistics_partner) || text(row.partner) : partners.join(' / '),
        reference: table === 'financial_periods' ? text(row.reference_cnpj) : references.join(' / '),
        field, cents, savedDate: text(rawDate), issue: issue || (cents === null ? 'Valor nao informado ou invalido na origem salva.' : ''), slots: unique(slots),
      };
      return { ...source, fingerprint: JSON.stringify([source.table, source.recordId, source.kind, source.title, source.period, source.partner, source.reference, source.field, value ?? null, source.savedDate, source.issue, linked.map(item => item.id)]) };
    };
    result.push(make('talitaJorge', view, 'financial_views', view.closingDerived ? 'formula atual: total iMile - receber Drops' : 'notes.summary.talitaJorge', summary.talitaJorge, scopeIssue, [slot('financial_views', text(view.id), 'talitaJorge')], summary.paymentDate));
    const hasPeriodInvoice = linked.some(row => row.net_amount !== null && row.net_amount !== undefined && row.net_amount !== '');
    for (const period of linked) {
      const periodIssue = !text(period.id) || !text(period.label) || !text(period.reference_cnpj) || !(text(period.logistics_partner) || text(period.partner)) ? 'Identidade incompleta no periodo salvo.' : '';
      if (hasPeriodInvoice) result.push(make('invoice', period, 'financial_periods', 'net_amount', period.net_amount, periodIssue, [slot('financial_periods', text(period.id), 'invoice')], period.payment_date));
    }
    if (!hasPeriodInvoice) result.push(make('invoice', view, 'financial_views', 'notes.summary.invoice', summary.invoice, scopeIssue,
      [slot('financial_views', text(view.id), 'invoice'), ...linked.map(row => slot('financial_periods', text(row.id), 'invoice'))], summary.paymentDate));
  }
  return result;
}

export function calculateClosingTax(base: number, rate: string): number {
  if (!Number.isSafeInteger(base) || base < 0 || base > 999999999999) throw new Error('Base de imposto deve ser zero ou positiva, em centavos.');
  const raw = rate.trim();
  if (!/^\d{1,3}([,.]\d{1,4})?$/.test(raw)) throw new Error('Informe aliquota percentual explicita, de 0 a 100, com ate quatro decimais.');
  const [whole, fraction = ''] = raw.replace(',', '.').split('.');
  const scaled = BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'));
  if (scaled > 1000000n) throw new Error('Aliquota deve estar entre 0 e 100%.');
  return Number((BigInt(base) * scaled + 500000n) / 1000000n);
}

export function closingLink(value: string): Link | null {
  if (!value.startsWith(prefix)) return null;
  try {
    const link = JSON.parse(value.slice(prefix.length));
    return link.version === 1 && typeof link.key === 'string' && Array.isArray(link.slots) && link.snapshot ? link as Link : null;
  } catch { return null; }
}
export function closingStatus(state: FinancialState, source: ClosingSource): 'review' | 'planned' | 'posted' | 'changed' | 'reversed' {
  const matches = (link: Link | null) => link && !link.taxEntry && link.slots.some(slot => source.slots.includes(slot));
  const cash = state.transactions.map(item => closingLink(item.source)).filter(matches) as Link[];
  const plans = state.plans.map(item => closingLink(item.notes)).filter(matches) as Link[];
  const links = [...cash, ...plans];
  if (links.some(link => link.snapshot.fingerprint !== source.fingerprint)) return 'changed';
  if (cash.some(link => link.reversalOf)) return 'reversed';
  return cash.length ? 'posted' : plans.length ? 'planned' : 'review';
}

export function confirmClosingChoices(state: FinancialState, sources: ClosingSource[], choices: ClosingChoice[]): FinancialState {
  if (!choices.length) throw new Error('Selecione ao menos uma origem.');
  const next = structuredClone(state);
  const keys = new Set<string>();
  for (const choice of choices) {
    const source = sources.find(item => item.key === choice.key);
    if (!source || source.fingerprint !== choice.fingerprint) throw new Error('Fonte alterada ou removida. Atualize e revise novamente; nenhum valor foi sobrescrito.');
    if (source.issue || source.cents === null) throw new Error(source.issue || 'Valor ausente.');
    if (keys.has(source.key)) throw new Error('Origem repetida na selecao.');
    keys.add(source.key);
    const status = closingStatus(next, source);
    if (status === 'changed' || status === 'posted' || status === 'reversed' || (status === 'planned' && choice.mode === 'planning')) throw new Error('Origem ja vinculada ou alterada. Confira o snapshot existente; reimportacao bloqueada.');
    if (!['empresa', 'pessoal'].includes(choice.destination)) throw new Error('Escolha destino empresa ou pessoal explicitamente.');
    if (!['planning', 'cash'].includes(choice.mode)) throw new Error('Escolha planejamento ou caixa.');
    const date = parseDate(choice.date);
    if (!choice.category.trim() || !choice.subcategory.trim()) throw new Error('Categoria e subcategoria de destino obrigatorias.');
    if (choice.mode === 'cash' && !choice.cashAcknowledged) throw new Error('Confirme o recebimento efetivo e o risco de duplicidade com extrato CSV.');
    const sibling = choices.some(item => item.key !== choice.key && sources.some(candidate => candidate.key === item.key && candidate.viewId === source.viewId && candidate.kind !== source.kind)) ||
      [...next.transactions.map(item => closingLink(item.source)), ...next.plans.map(item => closingLink(item.notes))].some(link => link && !link.reversalOf && link.snapshot.viewId === source.viewId && link.snapshot.kind !== source.kind);
    if (sibling && !choice.overlapAcknowledged) throw new Error('NF e resultado podem representar o mesmo dinheiro. Autorize valores distintos antes de vincular ambos.');
    let tax: Link['tax'] = null;
    if (choice.tax) {
      if (!['source', 'manual'].includes(choice.tax.basis)) throw new Error('Escolha a base do imposto explicitamente.');
      const base = choice.tax.basis === 'source' ? source.cents : parseMoney(choice.tax.base);
      tax = { rate: choice.tax.rate.trim(), basis: choice.tax.basis, base, cents: calculateClosingTax(base, choice.tax.rate) };
      if (choice.tax.post && (!choice.tax.category.trim() || !choice.tax.subcategory.trim())) throw new Error('Categoria e subcategoria do imposto obrigatorias.');
      if (choice.tax.post && choice.mode === 'cash' && !choice.tax.paidAcknowledged) throw new Error('Confirme pagamento efetivo do imposto antes de registrar saida de caixa.');
    }
    const planned = next.plans.find(item => { const link = closingLink(item.notes); return link && !link.taxEntry && link.slots.some(slot => source.slots.includes(slot)); });
    const prior = planned ? closingLink(planned.notes) : null;
    if (prior && (prior.destination !== choice.destination || planned!.category !== choice.category.trim() || planned!.subcategory !== choice.subcategory.trim() || planned!.detail !== choice.detail.trim())) throw new Error('Destino e categoria devem preservar o planejamento vinculado.');
    if (prior && JSON.stringify(prior.tax) !== JSON.stringify(tax)) throw new Error('Base e aliquota devem preservar o calculo revisado no planejamento.');
    const plannedTax = next.plans.find(item => { const link = closingLink(item.notes); return link && link.taxEntry && link.slots.some(slot => source.slots.includes(slot)); });
    if (plannedTax && choice.tax?.post && (plannedTax.category !== choice.tax.category.trim() || plannedTax.subcategory !== choice.tax.subcategory.trim())) throw new Error('Categoria do imposto deve preservar o planejamento vinculado.');
    const link: Link = { version: 1, key: source.key, slots: source.slots, snapshot: { ...structuredClone(source), slots: [] }, destination: choice.destination, date, mode: choice.mode, tax, taxEntry: false };
    const identity: Identity = { classification: source.cents < 0 ? 'Despesa' : 'Receita', category: choice.category.trim(), subcategory: choice.subcategory.trim(), detail: choice.detail.trim() };
    const description = `${source.kind === 'invoice' ? 'NF' : 'Talita/Jorge'} | ${source.title} | ${source.period} | ${source.partner} | ${source.reference} | ${choice.destination}`;
    const add = (entryId: string, amount: number, entryIdentity: Identity, entryLink: Link, label: string) => {
      if (choice.mode === 'cash') {
        const transaction: Transaction = { ...entryIdentity, id: entryId, amount, date, description: label, balance: null, sourceRow: null, source: prefix + JSON.stringify(entryLink), order: next.transactions.length };
        next.transactions.push(transaction);
      } else {
        const plan: Plan = { ...entryIdentity, id: entryId, amounts: { [date.slice(0, 7)]: Math.abs(amount) }, actualMonths: [], dueDay: Number(date.slice(-2)), pix: '', notes: prefix + JSON.stringify(entryLink), sourceRow: null };
        next.plans.push(plan);
      }
    };
    add(source.key, source.cents, identity, link, description);
    if (tax && choice.tax?.post) add(`${source.key}:tax`, -tax.cents, { classification: 'Despesa', category: choice.tax.category.trim(), subcategory: choice.tax.subcategory.trim(), detail: choice.detail.trim() }, { ...link, taxEntry: true }, `Imposto | ${description}`);
  }
  validateState(next);
  return next;
}

export function assertClosingSnapshots(previous: FinancialState, next: FinancialState): void {
  for (const original of previous.transactions.filter(item => closingLink(item.source))) {
    const current = next.transactions.find(item => item.id === original.id);
    if (JSON.stringify(current) !== JSON.stringify(original)) throw new Error('Snapshot de fechamento protegido. Use Fechamentos para registrar estorno, sem editar ou excluir o original.');
  }
  for (const original of previous.plans.filter(item => closingLink(item.notes))) {
    const current = next.plans.find(item => item.id === original.id);
    if (JSON.stringify(current) !== JSON.stringify(original)) throw new Error('Planejamento de fechamento protegido. Preserve o snapshot vinculado ao atualizar ou restaurar a base.');
  }
}

export function reverseClosing(state: FinancialState, transactionId: string, date: string, reason: string, acknowledged: boolean): FinancialState {
  const original = state.transactions.find(item => item.id === transactionId);
  const link = original ? closingLink(original.source) : null;
  if (!original || !link || link.reversalOf) throw new Error('Selecione um lancamento original de fechamento.');
  if (!reason.trim() || !acknowledged) throw new Error('Motivo e confirmacao do estorno efetivo obrigatorios.');
  if (state.transactions.some(item => closingLink(item.source)?.reversalOf === transactionId)) throw new Error('Lancamento ja estornado.');
  const effectiveDate = parseDate(date);
  const reversal: Transaction = { ...original, id: `${transactionId}:reversal`, date: effectiveDate, amount: -original.amount, classification: original.classification === 'Receita' ? 'Despesa' : 'Receita', description: `Estorno | ${original.description} | ${reason.trim()}`, balance: null, order: state.transactions.length, source: prefix + JSON.stringify({ ...link, reversalOf: transactionId, date: effectiveDate }) };
  const next = { ...state, transactions: [...state.transactions, reversal] };
  validateState(next);
  return next;
}