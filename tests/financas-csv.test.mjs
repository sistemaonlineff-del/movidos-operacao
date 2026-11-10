import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from '../src/financas/domain.ts';
import { previewStatement, mergeStatement, csvExport } from '../src/financas/csv.ts';
test('CSV aceita aspas e centavos e impede reimportacao',()=>{
  const state=emptyState();
  const preview=previewStatement('Data;Descricao;Valor;Saldo\n04/11/2026;"Pix recebido: Cliente; loja";10,32;100,01\n04/11/2026;"Pix recebido: Cliente; loja";10,32;100,01',state,'fixture');
  assert.equal(preview.errors.length,0); assert.equal(preview.rows.length,1); assert.equal(preview.duplicates,1); assert.equal(preview.rows[0].amount,1032);
  const next=mergeStatement(state,preview); assert.throws(()=>mergeStatement(next,preview));
  assert.equal(previewStatement('Data;Descricao;Valor;Saldo\n04/11/2026;"Pix recebido: Cliente; loja";10,32;100,01',next,'fixture').duplicates,1);
});
test('CSV invalido bloqueia lote inteiro, sem ignorar linhas',()=>{
  const state=emptyState(); const preview=previewStatement('Data;Descricao;Valor;Saldo\n31/02/2026;Teste;10,32;100,01\n04/11/2026;Teste;20,00;120,01',state,'fixture');
  assert.equal(preview.errors.length,1); assert.throws(()=>mergeStatement(state,preview)); assert.equal(state.transactions.length,0);
});
test('CSV legado inicia na linha 7 e exportacao neutraliza formulas',()=>{
  assert.equal(previewStatement('Banco\nConta\nPeriodo\n\n\n\n04/11/2026;Teste;-10,00;0,00',emptyState(),'fixture').rows.length,1);
  assert.match(csvExport([{Descricao:'=HYPERLINK("url")'}]), /'/);
});
test('CSV bancario com metadados e Data Lancamento preserva valores, saldos e devolucao',()=>{
  const text='\uFEFF'+[
    'Extrato Conta Corrente ',
    'Conta ;000000000',
    'Per\u00edodo ;17/10/2026 a 20/10/2026',
    'Saldo: ;6.950,00',
    '',
    'Data Lan\u00e7amento;Descri\u00e7\u00e3o;Valor;Saldo',
    '17/10/2026;Compra no debito: "No estabelecimento LOJA SINTETICA";-50,00;4.950,00',
    '17/10/2026;Pix enviado: "Cp :00000000-FORNECEDOR SINTETICO";-20,99;4.929,01',
    '19/10/2026;Pix recebido: "Cp :00000000-CLIENTE SINTETICO";2.000,00;6.929,01',
    '20/10/2026;Pix enviado devolvido: "Cp :00000000-FORNECEDOR SINTETICO";20,99;6.950,00',
    '',
  ].join('\r\n');
  const state=emptyState(),preview=previewStatement(text,state,'bank-format-fixture');
  assert.deepEqual(preview.errors,[]);
  assert.equal(preview.rows.length,4);
  assert.equal(preview.duplicates,0);
  assert.deepEqual(preview.rows.map(row=>row.amount),[-5000,-2099,200000,2099]);
  assert.deepEqual(preview.rows.map(row=>row.balance),[495000,492901,692901,695000]);
  assert.deepEqual(preview.rows.map(row=>row.date),['2026-10-17','2026-10-17','2026-10-19','2026-10-20']);
  assert.deepEqual(preview.rows.map(row=>row.sourceRow),[7,8,9,10]);
  assert.equal(preview.rows[3].description,'Pix enviado devolvido: "Cp :00000000-FORNECEDOR SINTETICO"');
  assert.equal(preview.total,195000);
  const next=mergeStatement(state,preview),repeat=previewStatement(text,next,'bank-format-fixture');
  assert.equal(next.transactions.length,4);
  assert.equal(state.transactions.length,0);
  assert.deepEqual(repeat.errors,[]);
  assert.equal(repeat.rows.length,0);
  assert.equal(repeat.duplicates,4);
});