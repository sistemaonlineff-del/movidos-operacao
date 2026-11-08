import test from 'node:test';
import assert from 'node:assert/strict';
import { createCnab, pixKey } from '../src/financas/cnab.ts';
const bank={branch:'1',branchDigit:'9',account:'123',accountDigit:'0',name:'EMPRESA TESTE',document:'12345678000190',street:'RUA TESTE',number:'1',complement:'',city:'SAO PAULO',state:'SP',postalCode:'01001000',sequence:3};
const payment={id:'p',name:'TESTE',responsible:'',amount:12345,pix:'teste@example.com',holder:'TESTE',date:'2026-11-04',document:'12345678909'};
test('CNAB possui 240 bytes, sequencias, datas, total e contagens coerentes',()=>{
  const lines=createCnab([payment],bank,new Date('2026-11-04T12:00:00')).trimEnd().split('\r\n');
  assert.equal(lines.length,6);
  const raw=createCnab([payment],bank).split('\r\n').slice(0,-1);assert.ok(raw.every(line=>Buffer.byteLength(line)===240));
  assert.equal(raw[0].slice(157,163),'000003');assert.equal(raw[2].slice(93,101),'04112026');assert.equal(raw[2].slice(119,134),'000000000012345');
  assert.equal(raw[4].slice(17,23),'000004');assert.equal(raw[5].slice(23,29),'000006');assert.equal(raw[4].slice(29,47),'000000000000012345');
});
test('CNAB bloqueia valores e chaves invalidos e nao inventa datas',()=>{
  for(const invalid of [{amount:0},{amount:-1},{date:''},{date:'2026-02-31'},{pix:'errado'},{document:''}]) assert.throws(()=>createCnab([{...payment,...invalid}],bank));
  assert.equal(pixKey('(11) 99999-9999').key,'+5511999999999'); assert.equal(pixKey('123.456.789-09').type,'03');
  assert.throws(()=>createCnab([payment],{...bank,sequence:0}));
});