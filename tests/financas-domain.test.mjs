import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, parseDate, emptyState, validateState, analysis, summary, transactionKey, suggestedClassification, isPlanned, planAmount, projection } from '../src/financas/domain.ts';

const identity = { classification: 'Despesa', category: 'Administrativa', subcategory: 'Aluguel', detail: '' };
const plan = { ...identity, id: 'p1', pix: '', notes: '', dueDay: 5, sourceRow: null, amounts: { '2026-10': 10000, '2026-11': null }, actualMonths: [] };
const transaction = { ...identity, id: 't1', date: '2026-10-10', description: 'Pagamento aluguel', amount: -12000, balance: null, sourceRow: null, source: 'manual', order: 0 };
test('moeda estrita preserva centavos, zero e negativos', () => {
  for (const [text, expected] of [['1.234,56',123456], ['0',0], ['-0,01',-1], ['1234.56',123456], ['1.234',123400]]) assert.equal(parseMoney(text), expected);
  for (const text of ['', '1,234', 'NaN', '1e3', '1.2.3', '12abc', 'Infinity']) assert.throws(() => parseMoney(text));
});
test('datas nao normalizam calendarios invalidos', () => {
  assert.equal(parseDate('04/11/2026'), '2026-11-04');
  for (const value of ['31/02/2026', '2026-13-01', '2026-02-29']) assert.throws(() => parseDate(value));
});
test('analise mensal e razao seguem formulas da planilha', () => {
  const state = emptyState(); state.transactions = [transaction]; state.plans = [plan]; validateState(state);
  assert.deepEqual(analysis(state,'2026-10')[0], { name:'Administrativa', planned:10000,actual:12000,delta:-2000,ratio:1.2,unknown:0 });
  assert.equal(summary(state,'2026-10').net,-12000);
  assert.equal(analysis(state,'2026-11')[0].unknown,1);
  state.plans[0].amounts['2026-10']=0; assert.equal(analysis(state,'2026-10')[0].ratio,1);
});
test('vinculo cadastral aceita descricao vazia e nao representa quitacao', () => {
  assert.equal(isPlanned(transaction,[plan]),true);
  assert.equal(isPlanned({...transaction,detail:'Outro'},[plan]),false);
});
test('planejado automatico de vendas usa competencia e quatro campos', () => {
  const auto = {...plan, actualMonths:['2026-10']};
  assert.equal(planAmount(auto,'2026-10',[transaction]),-12000);
  assert.equal(planAmount(auto,'2026-11',[transaction]),null);
});
test('identidade CSV ignora caixa e espacos mas preserva acentos', () => {
  assert.equal(transactionKey(transaction),transactionKey({...transaction,description:' PAGAMENTO   ALUGUEL '}));
  assert.notEqual(transactionKey(transaction),transactionKey({...transaction,amount:-12001}));
});
test('classificacao replica prioridades do VBA sem inferir demais debitos', () => {
  assert.equal(suggestedClassification('Pix recebido: Minha Empresa',['Minha Empresa']).category,'Transfer\u00eancia CC Cr\u00e9dito');
  assert.equal(suggestedClassification('Pix recebido: Cliente',[]).category,'Vendas diretas');
  assert.equal(suggestedClassification('Pix enviado',[]).classification,'Despesa');
  assert.equal(suggestedClassification('Compra no debito',[]).classification,'');
});
test('validacao bloqueia duplicidade de IDs, centavos fracionados e dias invalidos', () => {
  const state=emptyState(); validateState(state);
  state.transactions=[transaction,{...transaction}]; assert.throws(()=>validateState(state));
  state.transactions=[{...transaction,amount:0.1}]; assert.throws(()=>validateState(state));
  state.transactions=[]; state.plans=[{...plan,dueDay:32}]; assert.throws(()=>validateState(state));
});
test('projecao acumula receitas, despesas e ajustes assinados, sem inventar valores ausentes',()=>{
  const state=emptyState();state.plans=[{...plan,amounts:{'2026-10':10000,'2026-11':null}}];state.projection={opening:20000,adjustments:{'2026-10':{participation:-1000,other:500}}};
  const rows=projection(state);assert.equal(rows[0].balance,9500);assert.equal(rows[1].balance,9500);assert.equal(rows[1].unknown,1);
});
test('restauracao rejeita metadados e objetos incompletos antes de renderizar',()=>{
  const invalidCases=[
    {source:{name:'',sha256:'',importedAt:'',formulas:'8501'}},
    {issues:[{code:'TEST',sheet:'A',cell:'A1',message:{}}]},
    {bank:{sequence:1}},
    {projection:{opening:0,adjustments:[]}},
    {projection:{opening:0,adjustments:{'2026-10':null}}},
    {transactions:[null]},
    {plans:[{...plan,dueText:{}}]},
    {payments:[{id:'p',name:'',responsible:'',pix:'',holder:'',document:'',amount:0,date:0}]},
  ];
  for(const invalid of invalidCases)assert.throws(()=>validateState({...emptyState(),...invalid}));
});