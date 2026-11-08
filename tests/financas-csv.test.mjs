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