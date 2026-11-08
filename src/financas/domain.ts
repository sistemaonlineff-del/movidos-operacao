export type Classification = 'Receita' | 'Despesa' | '';
export type Identity = { classification: Classification; category: string; subcategory: string; detail: string };
export type Transaction = Identity & { id: string; date: string; description: string; amount: number; balance: number | null; sourceRow: number | null; source: string; order: number };
export type Plan = Identity & { id: string; pix: string; notes: string; dueDay: number | null; dueText?: string; sourceRow: number | null; amounts: Record<string, number | null>; actualMonths: string[] };
export type Catalog = { income: string[]; expense: string[]; children: Record<string, string[]> };
export type Payment = { id: string; name: string; responsible: string; amount: number; pix: string; holder: string; date: string; document: string };
export type Bank = { branch: string; branchDigit: string; account: string; accountDigit: string; name: string; document: string; street: string; number: string; complement: string; city: string; state: string; postalCode: string; sequence: number };
export type Issue = { code: string; sheet: string; cell: string; message: string };
export type FinancialState = { schemaVersion: 1; transactions: Transaction[]; plans: Plan[]; catalog: Catalog; payments: Payment[]; bank: Bank; projection: { opening: number; adjustments: Record<string, { participation: number; other: number }> }; transferNames: string[]; issues: Issue[]; source: { name: string; sha256: string; formulas: number; importedAt: string }; };
export type Envelope = { revision: number; data: FinancialState; updatedAt: string };

export const normalize = (value: string) => value.replace(/[\r\n]/g, ' ').trim().replace(/ +/g, ' ').toLocaleLowerCase('pt-BR');
export const searchable = (value: string) => normalize(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
export const identityKey = (item: Identity) => JSON.stringify([item.classification, item.category, item.subcategory, item.detail].map(normalize));
export const transactionKey = (item: Pick<Transaction, 'date' | 'description' | 'amount'>) => JSON.stringify([item.date, normalize(item.description), item.amount]);
export const money = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const monthLabel = (month: string) => new Date(`${month}-01T12:00:00`).toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' });
export const dateLabel = (date: string) => date ? date.split('-').reverse().join('/') : '';
export const amountInput = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');

export function parseMoney(value: string): number {
  let text = value.trim().replace(/^R\$\s*/, '');
  if (/^-?\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(text)) text = text.replaceAll('.', '');
  if (!/^-?\d+([,.]\d{1,2})?$/.test(text)) throw new Error('Valor invalido. Use 1.234,56; nao deixe vazio.');
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').replace(',', '.').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > 999999999999) throw new Error('Valor fora do limite permitido.');
  return negative ? -cents : cents;
}

export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value >= '1900-01-01' && value <= '2199-12-31';
}

export function parseDate(value: string): string {
  const text = value.trim();
  const parts = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  const iso = parts ? `${parts[3]}-${parts[2]}-${parts[1]}` : text;
  if (!validDate(iso)) throw new Error(`Data invalida: ${value}`);
  return iso;
}

export function emptyState(): FinancialState {
  return { schemaVersion: 1, transactions: [], plans: [], payments: [], catalog: { income: [], expense: [], children: {} }, bank: { branch: '', branchDigit: '', account: '', accountDigit: '', name: '', document: '', street: '', number: '', complement: '', city: '', state: '', postalCode: '', sequence: 1 }, projection: { opening: 0, adjustments: {} }, transferNames: [], issues: [], source: { name: '', sha256: '', formulas: 0, importedAt: '' } };
}

export function suggestedClassification(description: string, transferNames: string[]): Identity {
  const text = normalize(description);
  if (text.includes('pix recebido')) {
    if (transferNames.some(name => name.trim() && text.includes(normalize(name)))) return { classification: 'Receita', category: 'Transfer\u00eancia CC Cr\u00e9dito', subcategory: 'Transfer\u00eancia entre contas', detail: '' };
    return { classification: 'Receita', category: 'Vendas diretas', subcategory: 'Vendas diretas', detail: 'Vendas diretas' };
  }
  return { classification: text.includes('pix enviado') ? 'Despesa' : '', category: '', subcategory: '', detail: '' };
}

export function isPlanned(item: Identity, plans: Plan[]): boolean {
  return !!item.classification && plans.some(plan => identityKey(plan) === identityKey(item));
}

export function planAmount(plan: Plan, month: string, transactions: Transaction[]): number | null {
  if (!plan.actualMonths.includes(month)) return plan.amounts[month] ?? null;
  return transactions.filter(item => item.date.startsWith(month) && identityKey(item) === identityKey(plan)).reduce((sum, item) => sum + item.amount, 0);
}

export function analysis(state: FinancialState, month: string, classification: Classification = 'Despesa', group: 'category' | 'subcategory' | 'detail' = 'category') {
  const result = new Map<string, { name: string; planned: number; actual: number; delta: number; ratio: number; unknown: number }>();
  const ensure = (name: string) => {
    const key = normalize(name || 'Sem classificacao');
    if (!result.has(key)) result.set(key, { name: name || 'Sem classificacao', planned: 0, actual: 0, delta: 0, ratio: 0, unknown: 0 });
    return result.get(key)!;
  };
  for (const plan of state.plans.filter(item => item.classification === classification)) {
    const row = ensure(plan[group]);
    const amount = planAmount(plan, month, state.transactions);
    row.planned += amount ?? 0;
    row.unknown += amount === null ? 1 : 0;
  }
  for (const item of state.transactions.filter(item => item.classification === classification && item.date.startsWith(month))) ensure(item[group]).actual += Math.abs(item.amount);
  return [...result.values()].map(row => ({ ...row, delta: row.planned - row.actual, ratio: row.planned === 0 ? row.actual === 0 ? 0 : 1 : row.actual / row.planned })).sort((left, right) => right.actual - left.actual || left.name.localeCompare(right.name, 'pt-BR'));
}

export function summary(state: FinancialState, month: string) {
  const items = state.transactions.filter(item => item.date.startsWith(month));
  const income = items.filter(item => item.classification === 'Receita').reduce((sum, item) => sum + Math.abs(item.amount), 0);
  const expense = items.filter(item => item.classification === 'Despesa').reduce((sum, item) => sum + Math.abs(item.amount), 0);
  const net = items.reduce((sum, item) => sum + item.amount, 0);
  const plannedExpense = state.plans.filter(item => item.classification === 'Despesa').reduce((sum, item) => sum + (planAmount(item, month, state.transactions) ?? 0), 0);
  return { income, expense, net, plannedExpense, count: items.length, unclassified: items.filter(item => !item.classification || !item.category || !item.subcategory).length, unmatched: items.filter(item => !isPlanned(item, state.plans)).length };
}

export function monthsOf(state: FinancialState) {
  return [...new Set([...state.transactions.map(item => item.date.slice(0, 7)), ...state.plans.flatMap(item => Object.keys(item.amounts))])].sort();
}

export function projection(state: FinancialState) {
  let balance = state.projection.opening;
  return monthsOf(state).map(month => {
    let income = 0; let expense = 0; let unknown = 0;
    for (const plan of state.plans) {
      const amount = planAmount(plan, month, state.transactions);
      if (amount === null) unknown++;
      else if (plan.classification === 'Receita') income += amount;
      else expense += amount;
    }
    const adjustment = state.projection.adjustments[month] ?? { participation: 0, other: 0 };
    const net = income - expense;
    balance += net + adjustment.participation + adjustment.other;
    return { month, income, expense, net, ...adjustment, balance, unknown };
  });
}

export function validateState(input: unknown): asserts input is FinancialState {
  if (!input || typeof input !== 'object') throw new Error('Base invalida.');
  const state = input as FinancialState;
  if (state.schemaVersion !== 1 || !Array.isArray(state.transactions) || !Array.isArray(state.plans) || !Array.isArray(state.payments) || !state.catalog || !Array.isArray(state.issues) || !Array.isArray(state.transferNames) || !state.bank || !state.source) throw new Error('Estrutura da base invalida.');
  if (state.transactions.length > 100000 || state.plans.length > 10000) throw new Error('Base excede o limite desta versao.');
  const text = (value: unknown) => typeof value === 'string' && value.length <= 10000;
  const cents = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 999999999999;
  const record = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value);
  if (![state.catalog,state.catalog.children,state.bank,state.source,state.projection,state.projection?.adjustments].every(record)) throw new Error('Estrutura dos cadastros invalida.');
  if (!state.issues.every(item => record(item) && [item.code,item.sheet,item.cell,item.message].every(text)) || ![state.source.name,state.source.sha256,state.source.importedAt].every(text) || !Number.isSafeInteger(state.source.formulas) || state.source.formulas < 0) throw new Error('Registro de origem invalido.');
  const bankFields = ['branch','branchDigit','account','accountDigit','name','document','street','number','complement','city','state','postalCode'] as const;
  if (!bankFields.every(key => text(state.bank[key]))) throw new Error('Cadastro bancario incompleto.');
  if (!state.projection || !cents(state.projection.opening) || !state.projection.adjustments) throw new Error('Projecao invalida.');
  for (const [month, adjustment] of Object.entries(state.projection.adjustments)) if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month) || !record(adjustment) || !cents(adjustment.participation) || !cents(adjustment.other)) throw new Error('Ajuste de projecao invalido.');
  for (const collection of [state.transactions, state.plans, state.payments]) {
    const ids = new Set<string>();
    for (const item of collection) {
      if (!record(item) || !text(item.id) || !item.id || ids.has(item.id)) throw new Error('Identificador vazio ou duplicado.');
      ids.add(item.id);
    }
  }
  for (const item of [...state.transactions, ...state.plans]) if (!['', 'Receita', 'Despesa'].includes(item.classification) || ![item.category, item.subcategory, item.detail].every(text)) throw new Error('Classificacao invalida.');
  for (const item of state.transactions) if (!text(item.date) || !validDate(item.date) || !text(item.description) || !text(item.source) || !cents(item.amount) || (item.balance !== null && !cents(item.balance)) || !Number.isSafeInteger(item.order)) throw new Error('Lancamento invalido.');
  for (const plan of state.plans) {
    if (plan.dueText !== undefined && !text(plan.dueText)) throw new Error('Referencia de vencimento invalida.');
    if (!plan.classification || !plan.amounts || typeof plan.amounts !== 'object' || Array.isArray(plan.amounts) || !Array.isArray(plan.actualMonths) || !text(plan.pix) || !text(plan.notes) || (plan.dueDay !== null && (!Number.isInteger(plan.dueDay) || plan.dueDay < 1 || plan.dueDay > 31))) throw new Error('Planejamento invalido.');
    for (const [month, amount] of Object.entries(plan.amounts)) if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month) || (amount !== null && (!cents(amount) || amount < 0))) throw new Error('Competencia ou valor planejado invalido.');
    if (!plan.actualMonths.every(month => Object.hasOwn(plan.amounts, month))) throw new Error('Competencia automatica invalida.');
  }
  for (const payment of state.payments) if (![payment.name, payment.responsible, payment.pix, payment.holder, payment.document, payment.date].every(text) || !cents(payment.amount) || payment.amount < 0 || (payment.date && !validDate(payment.date))) throw new Error('Pagamento invalido.');
  if (!Number.isInteger(state.bank.sequence) || state.bank.sequence < 1 || state.bank.sequence > 999999 || !Object.entries(state.bank).filter(([key]) => key !== 'sequence').every(([, value]) => text(value))) throw new Error('Dados bancarios invalidos.');
  if (![state.catalog.income, state.catalog.expense, state.transferNames].every(list => Array.isArray(list) && list.every(text)) || !state.catalog.children || !Object.values(state.catalog.children).every(list => Array.isArray(list) && list.every(text))) throw new Error('Catalogo invalido.');
}