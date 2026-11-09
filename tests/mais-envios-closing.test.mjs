import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSync } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const compiled=buildSync({entryPoints:['src/maisEnviosClosing.ts'],bundle:true,platform:'node',format:'esm',write:false})
const domain=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)

test('Mais Envios code rules match VBA M_Inserir_Fechamento instead of the audio transcription',()=>{
  for(const code of ['AB123456789BR','ab123456789br','0123456789','01234567890'])assert.equal(domain.maisEnviosCodeValidity(code),'valid',code)
  for(const code of ['01234-567','01234567','BR1234567890123','br123456789012A'])assert.equal(domain.maisEnviosCodeValidity(code),'invalid',code)
  for(const code of ['12345','','123456789','BR1234','unknown'])assert.equal(domain.maisEnviosCodeValidity(code),'pending',code)
  assert.equal(domain.maisEnviosPostingValidity(' Entregue '),'valid')
  assert.equal(domain.maisEnviosPostingValidity('ETIQUETA EXPIRADA'),'invalid')
  assert.equal(domain.maisEnviosPostingValidity('Em transito'),'pending')
})

test('one distinct postal code is extracted across newlines, repeated copies are not multiple candidates',()=>{
  assert.equal(domain.extractMaisEnviosCode('label ab12345\r\n6789br AB123456789BR'),'AB123456789BR')
  assert.equal(domain.maisEnviosCodeValidity('label AB123456789BR AB123456789BR'),'valid')
  const ambiguous='AB123456789BR CD123456789BR'
  assert.equal(domain.extractMaisEnviosCode(ambiguous),ambiguous)
  assert.equal(domain.maisEnviosCodeValidity(ambiguous),'pending')
})

const market='Id;Cliente;Telefone;E-mail;Atendente;Codigo de Rastreio;Marketplace;Data de Criacao\n'
const posting='Etiqueta;Status;Remetente;Destinatario;Data Criacao;Data Postagem;Peso;Servico;Valor\n'
test('CSV preserves literal codes, keeps marketplace duplicates and chooses oldest creation, last row on tie',()=>{
  const imported=domain.importMaisEnviosCsv(market+'001;Pessoa;0011;teste@example.invalid;Smart A;0123456789;Loja;02/10/2026 10:00:00\n002;;;;Smart A;0123456789;Loja;01/10/2026 10:00:00\n003;;;;Smart A;0123456789;Loja;01/10/2026 10:00:00','Outubro',[])
  assert.equal(imported.rows[0].values[0],'001')
  const validated=domain.validateMaisEnviosRows(imported.rows)
  assert.deepEqual(validated.map(row=>row.validity),['duplicate','duplicate','valid'])
  const next=domain.validateMaisEnviosRows([imported.rows[0]],validated)
  assert.equal(next[0].validity,'duplicate')
  assert.equal(domain.validateMaisEnviosRows([{...imported.rows[0],code:''}])[0].validity,'pending')
  assert.equal(domain.maisEnviosDate('31/02/2026'),0)
  assert.ok(domain.maisEnviosDate('28/02/2026')>0)
})
test('posting labels deduplicate case-insensitively and only exact recognized status is automatic',()=>{
  const imported=domain.importMaisEnviosCsv(posting+'XX001;Etiqueta expirada;A;B;2026-10-01;2026-10-02;1;Servico;1.234,56\nxx001;Entregue;A;B;2026-10-01;2026-10-02;1;Servico;2,00\nYY002;Em transito;A;B;2026-10-01;2026-10-02;1;Servico;10,00','Outubro',[],'Smart B')
  assert.equal(imported.skipped,1)
  const rows=domain.validateMaisEnviosRows(imported.rows)
  assert.deepEqual(rows.map(row=>row.validity),['valid','pending'])
  assert.equal(rows[0].valueCents,200)
  assert.equal(rows[0].values[1],'Entregue')
  assert.equal(domain.importMaisEnviosCsv(posting+'XX001;Entregue;A;B;2026-10-01;2026-10-02;1;Servico;1,00','Novembro',rows,'Smart B').skipped,1)
})
test('summary uses each row period, includes posting-only Smarts, computes exact cents and settlement direction',()=>{
  const packages=domain.importMaisEnviosCsv(market+'001;;;;Smart A;0123456789;Loja;01/10/2026','Outubro',[]).rows
  const paid=domain.importMaisEnviosCsv(posting+'X;Entregue;A;B;2026-10-01;2026-10-02;1;Servico;100,00','Outubro',[],'Smart B').rows
  const other=domain.importMaisEnviosCsv(posting+'Y;Entregue;A;B;2026-11-01;2026-11-02;1;Servico;999,00','Novembro',[],'Smart B').rows
  const summary=domain.maisEnviosSummaries(domain.validateMaisEnviosRows([...packages,...paid,...other]),'Outubro')
  assert.deepEqual(summary.map(row=>[row.smart,row.packages,row.marketplaceCents,row.postingCents,row.smartShareCents,row.companyShareCents,row.resultCents,row.direction]),[
    ['Smart A',1,50,0,0,0,50,'+Envios paga para Smart'],['Smart B',0,0,10000,1500,8500,8500,'Smart paga para +Envios']])
  const fractions=domain.maisEnviosSummaries([{...paid[0],valueCents:10,validity:'valid'},{...packages[0],validity:'valid',smart:'Smart B'}],'Outubro')[0]
  assert.equal(fractions.resultCents,42)
  assert.throws(()=>domain.maisEnviosCents('1,234'),/invalido/)
  assert.throws(()=>domain.importMaisEnviosCsv('unknown;a;b','Outubro',[]),/nao reconhecido/)
})

test('Mais Envios migration is isolated, repeatable, financial-only, immutable and blocks cross-period double charges',async()=>{
  const db=new PGlite()
  const id='11111111-1111-4111-8111-111111111111'
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
      create function auth.uid() returns uuid language sql as $$select '${id}'::uuid$$;
      create table user_profiles(id uuid primary key,role text,is_active boolean);
      create table user_module_permissions(user_id uuid,financeiro_view boolean,financeiro_manage boolean);
      insert into user_profiles values('${id}','operador',true);
      insert into user_module_permissions values('${id}',true,false);`)
    const sql=await readFile('supabase/migrations/20261109130000_mais_envios_closings.sql','utf8')
    await db.exec(sql);await db.exec(sql)
    const rows=domain.validateMaisEnviosRows(domain.importMaisEnviosCsv(market+'001;;;;Smart A;0123456789;Loja;01/10/2026','Outubro',[]).rows)
    const contacts=[{smart:'Smart A',email:'teste@example.invalid',responsible:'Pessoa sintetica',registrationId:null}]
    const insert=(period='Outubro',data=rows)=>db.query('insert into mais_envios_closings(id,period,rows,contacts,subject,body,created_by) values($1,$2,$3,$4,$5,$6,$7)',[crypto.randomUUID(),period,JSON.stringify(data),JSON.stringify(contacts),'Fechamento','Texto sintetico',id])
    await db.exec('set role anon');await assert.rejects(db.exec('select * from mais_envios_closings'),/permission denied/)
    await db.exec('reset role;set role authenticated')
    assert.equal((await db.query('select count(*) from mais_envios_closings')).rows[0].count,0)
    await assert.rejects(insert(),/Sem permissao|row-level security/)
    await db.exec("reset role;update user_module_permissions set financeiro_manage=true;set role authenticated")
    await insert()
    await assert.rejects(insert('Novembro',rows.map(row=>({...row,period:'Novembro'}))),/ja confirmado/)
    await db.exec('reset role;update user_module_permissions set financeiro_manage=false;set role authenticated')
    await assert.rejects(insert('Novembro',rows.map(row=>({...row,period:'Novembro'}))),/Sem permissao/)
    await db.exec('reset role;update user_module_permissions set financeiro_manage=true;set role authenticated')
    await assert.rejects(db.exec("update mais_envios_closings set subject='Alterado'"),/permission denied/)
    await assert.rejects(db.exec('delete from mais_envios_closings'),/permission denied/)
    await assert.rejects(db.exec("insert into mais_envios_closing_mail(closing_id,smart_key,recipient,status,created_by) select id,'smart a','teste@example.invalid','aceito',created_by from mais_envios_closings"),/permission denied/)
    const snapshot=(await db.query('select * from mais_envios_closings')).rows
    await db.exec('reset role');await db.exec(sql)
    assert.deepEqual((await db.query('select * from mais_envios_closings')).rows,snapshot)
    await db.exec("update user_profiles set is_active=false;set role authenticated")
    assert.equal((await db.query('select count(*) from mais_envios_closings')).rows[0].count,0)
  }finally{await db.close()}
})

test('provided private XLSM cached summary agrees with the port without importing its records',{skip:!process.env.MAIS_ENVIOS_WORKBOOK},async()=>{
  const XLSX=await import('xlsx')
  const workbook=XLSX.read(await readFile(process.env.MAIS_ENVIOS_WORKBOOK),{type:'buffer',cellDates:true})
  const sheet=workbook.Sheets.Detalhamento,source=[]
  const value=(row,column)=>{
    const cell=sheet[XLSX.utils.encode_cell({r:row,c:column})]
    return cell?.v instanceof Date?cell.v.toISOString():String(cell?.v??'').trim()
  }
  const storedValidity=value=>value.toLowerCase()==='sim'?'valid':value.toLowerCase()==='duplicidade'?'duplicate':value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')==='nao'?'invalid':'pending'
  for(let row=2;row<=XLSX.utils.decode_range(sheet['!ref']).e.r;row++){
    for(const kind of['marketplace','posting']){
      const start=kind==='marketplace'?1:12,values=Array.from({length:kind==='marketplace'?8:9},(_,index)=>value(row,start+index))
      const code=values[kind==='marketplace'?5:0]
      if(!code)continue
      const validity=storedValidity(value(row,kind==='marketplace'?9:21))
      source.push({id:crypto.randomUUID(),kind,period:value(row,kind==='marketplace'?0:11),values,originalCode:code,code,smart:value(row,kind==='marketplace'?5:22),createdAt:values[kind==='marketplace'?7:4],valueCents:kind==='posting'?Math.round(Number(value(row,20))*100):0,validity,manual:['valid','invalid'].includes(validity)?validity:null})
    }
  }
  const validated=domain.validateMaisEnviosRows(source),summarySheet=workbook.Sheets['Resumo Final']
  const summaries=domain.maisEnviosSummaries(validated,String(summarySheet.B3.v))
  let compared=0,mismatches=0
  for(const[address,cell]of Object.entries(summarySheet)){
    if(!/^B\d+$/.test(address)||!cell.f?.startsWith('IFERROR(INDEX(')||!cell.v)continue
    const row=address.slice(1),summary=summaries.find(item=>domain.maisEnviosSmartKey(item.smart)===domain.maisEnviosSmartKey(String(cell.v)))
    if(!summary){mismatches++;continue}
    for(const[column,field]of[['E','marketplaceCents'],['F','postingCents'],['G','smartShareCents'],['H','companyShareCents'],['M','resultCents']]){
      compared++;if(Math.abs(summary[field]-Math.round(Number(summarySheet[column+row]?.v??0)*100))>1)mismatches++
    }
  }
  assert.ok(compared>0,'Expected cached summary formulas in the provided model')
  assert.equal(mismatches,0,`Differences beyond one-cent display rounding: ${mismatches}; compared values: ${compared}`)
  console.log(`Private XLSM reference: ${compared} cached financial values checked, zero differences beyond one cent; original file unchanged, no customer records copied.`)
})