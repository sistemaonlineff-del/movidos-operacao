import test from 'node:test';
import assert from 'node:assert/strict';
import { closingSources, calculateClosingTax, closingLink, closingStatus, confirmClosingChoices, reverseClosing, assertClosingSnapshots } from '../src/financas/closing.ts';
import { emptyState } from '../src/financas/domain.ts';

const view = { id: 'view-1', title: 'Fechamento salvo', notes: JSON.stringify({ summary: { period: '1Q', invoice: 200, talitaJorge: 0, paymentDate: '2026-11-15' } }) };
const period = { id: 'period-1', financial_view_id: 'view-1', label: '1Q', partner: 'iMile', reference_cnpj: 'MOVIDOS', net_amount: null };
const sources = () => closingSources([view], [period]);
const choice = (source, overrides = {}) => ({ key: source.key, fingerprint: source.fingerprint, destination: 'pessoal', date: '2026-11-08', category: 'Receitas', subcategory: 'Fechamentos', detail: '', mode: 'planning', cashAcknowledged: false, overlapAcknowledged: false, ...overrides });

test('saved summary values only; zero is present; no profit difference or payment-date inference', () => {
  const rows = sources();
  assert.equal(rows[0].cents, 0);
  assert.equal(rows[1].cents, 20000);
  assert.equal(rows[1].field, 'notes.summary.invoice');
  assert.equal(closingSources([{ ...view, notes: '{}' }], [{ ...period, net_amount: 500 }])[0].cents, null);
  const nf = closingSources([view], [{ ...period, net_amount: 0 }])[1];
  assert.equal(nf.cents, 0);
  assert.equal(nf.savedDate, '');
  assert.equal(nf.field, 'net_amount');
});
test('inactive, malformed, missing and ambiguous saved values never become income', () => {
  assert.deepEqual(closingSources([{ ...view, is_active: false }], [period]), []);
  for (const value of [null, '', undefined, 'invalid', true, 0.001]) {
    const row = closingSources([{ ...view, notes: { summary: { talitaJorge: value } } }], [period])[0];
    assert.equal(row.cents, null);
    assert.ok(row.issue);
  }
  const mixed = closingSources([view], [period, { ...period, id: 'p2', reference_cnpj: 'BELLY' }]);
  assert.ok(mixed.every(item => item.issue));
  assert.ok(closingSources([view], [{ ...period, reference_cnpj: null }])[0].issue);
});
test('exact tax cents, explicit rate/base, zero accepted, half-up rounding and bounds', () => {
  assert.equal(calculateClosingTax(1, '50'), 1);
  assert.equal(calculateClosingTax(10001, '6,125'), 613);
  assert.equal(calculateClosingTax(999999999999, '99.9999'), 999998999999);
  assert.equal(calculateClosingTax(0, '0'), 0);
  for (const rate of ['', ' ', '-1', '100.0001', '101', '6%', '0.00001']) assert.throws(() => calculateClosingTax(100, rate));
  assert.throws(() => calculateClosingTax(-1, '10'));
});
test('review is read-only; explicit mapping, date and receipt acknowledgment required', () => {
  const state = emptyState(), row = sources()[1];
  assert.equal(closingStatus(state, row), 'review');
  assert.throws(() => confirmClosingChoices(state, sources(), []));
  for (const overrides of [{ destination: '' }, { date: '' }, { category: '' }, { subcategory: '' }, { mode: 'cash' }]) assert.throws(() => confirmClosingChoices(state, sources(), [choice(row, overrides)]));
  assert.deepEqual(state, emptyState());
});
test('planning does not inflate cash; links persist through reopen and block repeats independent of destination/date', () => {
  const row = sources()[1];
  const planned = confirmClosingChoices(emptyState(), sources(), [choice(row)]);
  assert.equal(planned.transactions.length, 0);
  assert.equal(planned.plans[0].amounts['2026-11'], 20000);
  const reopened = JSON.parse(JSON.stringify(planned));
  assert.equal(closingStatus(reopened, row), 'planned');
  assert.throws(() => confirmClosingChoices(reopened, sources(), [choice(row, { destination: 'empresa', date: '2026-12-01' })]), /ja vinculada/);
  const cash = confirmClosingChoices(reopened, sources(), [choice(row, { mode: 'cash', cashAcknowledged: true })]);
  assert.equal(cash.transactions.length, 1);
  assert.equal(cash.plans[0].amounts['2026-11'], 20000);
  assert.equal(closingLink(cash.transactions[0].source).snapshot.cents, 20000);
  assert.throws(() => confirmClosingChoices(cash, sources(), [choice(row, { mode: 'cash', cashAcknowledged: true })]), /ja vinculada/);
});
test('summary NF and later period NF share lineage to prevent double import', () => {
  const rows = sources();
  const cash = confirmClosingChoices(emptyState(), rows, [choice(rows[1], { mode: 'cash', cashAcknowledged: true })]);
  const changed = closingSources([view], [{ ...period, net_amount: 200 }]);
  assert.equal(closingStatus(cash, changed[1]), 'changed');
  assert.throws(() => confirmClosingChoices(cash, changed, [choice(changed[1])]), /ja vinculada/);
});
test('NF plus result requires distinct-money authorization, including previously linked origins', () => {
  const rows = sources();
  assert.throws(() => confirmClosingChoices(emptyState(), rows, rows.map(row => choice(row))), /mesmo dinheiro/);
  const result = confirmClosingChoices(emptyState(), rows, rows.map(row => choice(row, { overlapAcknowledged: true })));
  assert.equal(result.plans.length, 2);
  const nf = confirmClosingChoices(emptyState(), rows, [choice(rows[1])]);
  assert.throws(() => confirmClosingChoices(nf, rows, [choice(rows[0])]), /mesmo dinheiro/);
});
test('source updates/removal reject stale selection and preserve original snapshots/money', () => {
  const rows = sources();
  const state = confirmClosingChoices(emptyState(), rows, [choice(rows[1])]);
  const changed = closingSources([{ ...view, notes: { summary: { invoice: 999, talitaJorge: 0 } } }], [period]);
  assert.equal(closingStatus(state, changed[1]), 'changed');
  assert.throws(() => confirmClosingChoices(emptyState(), changed, [choice(rows[1])]), /Fonte alterada/);
  assert.throws(() => confirmClosingChoices(state, [], [choice(rows[1])]), /removida/);
  assert.equal(state.plans[0].amounts['2026-11'], 20000);
});
test('tax preview is not an automatic debit; manual base/rate and paid tax require explicit input', () => {
  const row = sources()[1], tax = { rate: '6', basis: 'manual', base: '100,01', category: '', subcategory: '', post: false, paidAcknowledged: false };
  const cash = confirmClosingChoices(emptyState(), sources(), [choice(row, { mode: 'cash', cashAcknowledged: true, tax })]);
  assert.equal(cash.transactions.length, 1);
  assert.equal(closingLink(cash.transactions[0].source).tax.cents, 600);
  for (const invalid of [{ ...tax, base: '' }, { ...tax, rate: '' }, { ...tax, basis: '' }, { ...tax, post: true }]) assert.throws(() => confirmClosingChoices(emptyState(), sources(), [choice(row, { tax: invalid })]));
  const post = { ...tax, post: true, category: 'Imposto', subcategory: 'NF' };
  assert.throws(() => confirmClosingChoices(emptyState(), sources(), [choice(row, { mode: 'cash', cashAcknowledged: true, tax: post })]), /pagamento efetivo/);
  const paid = confirmClosingChoices(emptyState(), sources(), [choice(row, { mode: 'cash', cashAcknowledged: true, tax: { ...post, paidAcknowledged: true } })]);
  assert.equal(paid.transactions[1].amount, -600);
});
test('explicit reversal is append-only, keeps snapshot, blocks second reversal/reimport', () => {
  const row = sources()[1];
  const cash = confirmClosingChoices(emptyState(), sources(), [choice(row, { mode: 'cash', cashAcknowledged: true })]);
  const original = JSON.stringify(cash.transactions[0]);
  assert.throws(() => reverseClosing(cash, row.key, '2026-11-09', '', true));
  const reversed = reverseClosing(cash, row.key, '2026-11-09', 'Devolucao confirmada', true);
  assert.equal(JSON.stringify(reversed.transactions[0]), original);
  assert.equal(reversed.transactions[1].amount, -20000);
  assert.equal(closingStatus(reversed, row), 'reversed');
  assert.throws(() => reverseClosing(reversed, row.key, '2026-11-10', 'Novamente', true), /ja estornado/);
  assert.throws(() => confirmClosingChoices(reversed, sources(), [choice(row)]), /ja vinculada/);
});
test('generic edits, deletions and old restore cannot erase closing origin or money', () => {
  const row = sources()[1];
  const planned = confirmClosingChoices(emptyState(), sources(), [choice(row)]);
  assert.throws(() => assertClosingSnapshots(planned, emptyState()), /Planejamento.*protegido/);
  const cash = confirmClosingChoices(planned, sources(), [choice(row, { mode: 'cash', cashAcknowledged: true })]);
  assert.doesNotThrow(() => assertClosingSnapshots(planned, cash));
  const edited = structuredClone(cash); edited.transactions[0].amount++;
  assert.throws(() => assertClosingSnapshots(cash, edited), /Snapshot.*protegido/);
  const reversed = reverseClosing(cash, row.key, '2026-11-09', 'Confirmado', true);
  assert.doesNotThrow(() => assertClosingSnapshots(cash, reversed));
});
test('moving a planned tax to cash preserves reviewed rate, basis and category', () => {
  const row = sources()[1], tax = { rate: '6', basis: 'source', base: '', category: 'Imposto', subcategory: 'NF', post: true, paidAcknowledged: false };
  const planned = confirmClosingChoices(emptyState(), sources(), [choice(row, { tax })]);
  assert.throws(() => confirmClosingChoices(planned, sources(), [choice(row, { mode: 'cash', cashAcknowledged: true, tax: { ...tax, rate: '7', paidAcknowledged: true } })]), /Base e aliquota/);
  assert.throws(() => confirmClosingChoices(planned, sources(), [choice(row, { mode: 'cash', cashAcknowledged: true, tax: { ...tax, category: 'Outra', paidAcknowledged: true } })]), /Categoria do imposto/);
  const cash = confirmClosingChoices(planned, sources(), [choice(row, { mode: 'cash', cashAcknowledged: true, tax: { ...tax, paidAcknowledged: true } })]);
  assert.equal(cash.transactions[1].amount, -1200);
  assert.doesNotThrow(() => assertClosingSnapshots(planned, cash));
});
test('summary snapshots stay within existing source-string limit for typical large closings', () => {
  const periods = Array.from({ length: 100 }, (_, index) => ({ ...period, id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` }));
  const rows = closingSources([view], periods);
  const cash = confirmClosingChoices(emptyState(), rows, [choice(rows[1], { mode: 'cash', cashAcknowledged: true })]);
  assert.ok(cash.transactions[0].source.length <= 10000);
});