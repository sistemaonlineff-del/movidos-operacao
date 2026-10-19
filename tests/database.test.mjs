import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

test('shared invoice intake migration is repeatable, private and enforces atomic daily quotas',async()=>{
  const database=new PGlite()
  try{
    await database.exec('create role anon;create role authenticated;create role service_role bypassrls;create table financial_periods(id uuid primary key);create table drops(id uuid primary key);create table user_profiles(id uuid primary key);')
    const migration=await readFile('supabase/migrations/20261018120000_shared_invoice_intake.sql','utf8')
    await database.exec(migration);await database.exec(migration)
    for(const table of ['financial_invoice_intake','financial_invoice_intake_limits']){
      assert.equal((await database.query(`select relrowsecurity from pg_class where relname='${table}'`)).rows[0].relrowsecurity,true)
      assert.equal((await database.query(`select has_table_privilege('anon','${table}','select') as allowed`)).rows[0].allowed,false)
      assert.equal((await database.query(`select has_table_privilege('authenticated','${table}','insert') as allowed`)).rows[0].allowed,false)
    }
    await database.exec('set role anon')
    await assert.rejects(database.exec(`select reserve_invoice_intake('${'a'.repeat(64)}')`),/permission denied/)
    await database.exec('reset role;set role service_role')
    for(let count=0;count<50;count++)assert.equal((await database.query(`select reserve_invoice_intake('${'a'.repeat(64)}') as allowed`)).rows[0].allowed,true)
    assert.equal((await database.query(`select reserve_invoice_intake('${'a'.repeat(64)}') as allowed`)).rows[0].allowed,false)
    assert.equal((await database.query(`select reserve_invoice_intake('invalid') as allowed`)).rows[0].allowed,false)
    await database.exec("update financial_invoice_intake_limits set attempts=1000 where bucket='global'")
    assert.equal((await database.query(`select reserve_invoice_intake('${'b'.repeat(64)}') as allowed`)).rows[0].allowed,false)
    await database.exec('reset role');await database.exec(migration)
    assert.equal((await database.query("select attempts from financial_invoice_intake_limits where bucket='global'")).rows[0].attempts,1000)
  }finally{await database.close()}
})

test('dated successors share a point without overlapping operations or changing history and permissions', async () => {
  const database = new PGlite()
  try {
    await database.exec(`create role authenticated;
      create table drops(id uuid primary key default gen_random_uuid(),name text,partner text,municipality text,registration_type text,is_active boolean default true,responsible text,operation_started_at date,operation_ended_at date);
      alter table drops enable row level security;
      create policy existing_access on drops for select to authenticated using(true);
      insert into drops(name,partner,municipality,responsible,operation_started_at,operation_ended_at,is_active) values('MGC 5','IMILE','Suzano','Davi','2026-08-01','2026-10-10',false);`)
    const before = (await database.query('select * from drops')).rows
    const policies = (await database.query('select * from pg_policies')).rows
    const migration = await readFile('supabase/migrations/20261014130000_registration_operation_successors.sql', 'utf8')
    await database.exec(migration); await database.exec(migration)
    assert.deepEqual((await database.query('select * from drops')).rows, before)
    await database.exec("insert into drops(name,partner,municipality,responsible,operation_started_at) values(' mgc 5 ','imile','SUZANO','Gustavo','2026-10-11')")
    assert.equal((await database.query('select count(*) from drops')).rows[0].count, 2)
    await assert.rejects(database.exec("insert into drops(name,partner,municipality,responsible,operation_started_at) values('MGC 5','IMILE','Suzano','Outro','2026-10-10')"), /sobrepostas/)
    await assert.rejects(database.exec("insert into drops(name,partner,municipality,responsible) values('MGC 5','IMILE','Suzano','Sem datas')"), /sobrepostas/)
    await assert.rejects(database.exec("update drops set operation_started_at='2026-10-10' where responsible='Gustavo'"), /sobrepostas/)
    await assert.rejects(database.exec("update drops set operation_ended_at='2026-10-11' where responsible='Davi'"), /sobrepostas/)
    await database.exec("update drops set responsible='Davi corrigido' where responsible='Davi'")
    await database.exec("insert into drops(name,partner,municipality,responsible) values('MGC 5','OUTRO','Suzano','Outro parceiro')")
    await database.exec(migration)
    assert.equal((await database.query("select operation_started_at::text from drops where responsible='Gustavo'")).rows[0].operation_started_at, '2026-10-11')
    assert.deepEqual((await database.query('select * from pg_policies')).rows, policies)
  } finally { await database.close() }
})

test('registration snapshot migration preserves history, permissions and snapshots after registration changes', async () => {
  const database = new PGlite()
  try {
    await database.exec(`create role authenticated;
      create table financial_drop_items(id integer primary key, unit_value numeric);
      alter table financial_drop_items enable row level security;
      create policy finance_existing on financial_drop_items for select to authenticated using(true);
      insert into financial_drop_items values(1,.13);
      create table drops(id integer primary key,responsible text,pix_key text);
      insert into drops values(1,'Davi','00123');`)
    const policies = (await database.query('select * from pg_policies')).rows
    const migration = await readFile('supabase/migrations/20261014120000_financial_registration_snapshots.sql', 'utf8')
    await database.exec(migration); await database.exec(migration)
    assert.deepEqual((await database.query('select * from financial_drop_items')).rows, [{ id: 1, unit_value: '0.13', registration_snapshot: null }])
    await database.exec(`insert into financial_drop_items values(2,.25,'{"version":1,"responsible":"Davi","pix":"00123"}');
      update drops set responsible='Gustavo',pix_key='99999';`)
    assert.equal((await database.query('select registration_snapshot from financial_drop_items where id=2')).rows[0].registration_snapshot.responsible, 'Davi')
    await database.exec(migration)
    assert.equal((await database.query('select registration_snapshot from financial_drop_items where id=2')).rows[0].registration_snapshot.pix, '00123')
    assert.deepEqual((await database.query('select * from pg_policies')).rows, policies)
  } finally { await database.close() }
})

test('financial view controls rename atomically, isolate references, reject duplicates and deactivate without deleting', async () => {
  const database = new PGlite()
  try {
    await database.exec(`create role authenticated; create role anon; create schema auth;
      create function auth.uid() returns uuid language sql as $$select '11111111-1111-4111-8111-111111111111'::uuid$$;
      create function is_active_user() returns boolean language sql as $$select true$$;
      create function is_admin() returns boolean language sql as $$select current_setting('test.allowed',true)='yes'$$;
      create function has_module_permission(text) returns boolean language sql as $$select false$$;
      create table user_profiles(id uuid primary key); insert into user_profiles values(auth.uid());
      create table financial_views(id uuid primary key,title text,is_active boolean default true,deactivated_reason text,deactivated_at timestamptz,deactivated_by uuid);
      create table financial_periods(id uuid primary key,financial_view_id uuid, label text,partner text,logistics_partner text,reference_cnpj text,net_amount numeric,is_active boolean default true,deactivated_reason text,deactivated_at timestamptz,deactivated_by uuid);
      create unique index financial_periods_view_label_partner_key on financial_periods(financial_view_id,label,partner) nulls not distinct;
      create table financial_drop_items(id uuid primary key,financial_period_id uuid,amount numeric,is_active boolean default true,deactivated_reason text,deactivated_at timestamptz,deactivated_by uuid);
      create table financial_payment_history(like financial_drop_items including all); alter table financial_payment_history add period_label text;
      create table loss_events(like financial_payment_history including all);
      create table email_logs(financial_period_id uuid,status text);
      insert into financial_views(id,title) values('22222222-2222-4222-8222-222222222222','35. 2Q DE SETEMBRO'),('33333333-3333-4333-8333-333333333333','Outro');
      insert into financial_periods(id,financial_view_id,label,partner,logistics_partner,reference_cnpj,net_amount) values('44444444-4444-4444-8444-444444444444','22222222-2222-4222-8222-222222222222','35. 2Q DE SETEMBRO','IMILE DELIVERY BRAZIL LTDA','IMILE DELIVERY BRAZIL LTDA','MOVIDOS',123);
      insert into financial_drop_items(id,financial_period_id,amount) values('55555555-5555-4555-8555-555555555555','44444444-4444-4444-8444-444444444444',10);
      insert into financial_payment_history select *, '35. 2Q DE SETEMBRO' from financial_drop_items;
      insert into loss_events select * from financial_payment_history;`)
    const migration = await readFile('supabase/migrations/20261012100000_financial_view_controls.sql','utf8')
    await database.exec(migration); await database.exec(migration)
    await database.exec("insert into financial_periods select '77777777-7777-4777-8777-777777777777',financial_view_id,label,partner,logistics_partner,'BELLY',200,true,null,null,null from financial_periods limit 1")
    assert.equal((await database.query('select count(*) from financial_periods')).rows[0].count,2)
    await database.exec("delete from financial_periods where id='77777777-7777-4777-8777-777777777777'")
    const rename = "select change_financial_view('22222222-2222-4222-8222-222222222222','35. 2Q DE SETEMBRO','rename','Correcao de digitacao','35. 1Q DE SETEMBRO')"
    await assert.rejects(database.exec(rename),/permissao/)
    await database.exec("select set_config('test.allowed','yes',false)")
    await assert.rejects(database.exec("select change_financial_view('22222222-2222-4222-8222-222222222222','35. 2Q DE SETEMBRO',null,'Motivo valido')"),/acao/)
    await database.exec(rename)
    assert.equal((await database.query('select label,net_amount from financial_periods')).rows[0].label,'35. 1Q DE SETEMBRO')
    assert.equal((await database.query('select net_amount from financial_periods')).rows[0].net_amount,'123')
    assert.equal((await database.query('select period_label from financial_payment_history')).rows[0].period_label,'35. 1Q DE SETEMBRO')
    await assert.rejects(database.exec(rename),/mudou/)
    await assert.rejects(database.exec("insert into financial_periods select '66666666-6666-4666-8666-666666666666','33333333-3333-4333-8333-333333333333',label,partner,logistics_partner,reference_cnpj,net_amount,true,null,null,null from financial_periods limit 1"),/duplicado/)
    await database.exec("insert into financial_periods select '66666666-6666-4666-8666-666666666666','33333333-3333-4333-8333-333333333333',label,partner,logistics_partner,'BELLY',200,true,null,null,null from financial_periods limit 1")
    await database.exec("select change_financial_view('22222222-2222-4222-8222-222222222222','35. 1Q DE SETEMBRO','deactivate','Importacao cancelada')")
    for (const table of ['financial_drop_items','financial_payment_history','loss_events']) assert.equal((await database.query(`select is_active,amount from ${table}`)).rows[0].is_active,false)
    assert.equal((await database.query("select is_active from financial_periods where reference_cnpj='BELLY'")).rows[0].is_active,true)
    assert.equal((await database.query('select count(*) from financial_view_changes')).rows[0].count,2)
    const maintenance=await readFile('supabase/maintenance/exclude_wrong_september_view.sql','utf8')
    await assert.rejects(database.exec(maintenance),/Informe em target_id/)
    await database.exec('rollback')
    const wrongId='88888888-8888-4888-8888-888888888888',wrongPeriod='99999999-9999-4999-8999-999999999999'
    await database.exec(`insert into financial_views(id,title) values('${wrongId}','35. 2Q DE SETEMBRO'),('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','36. 2Q DE SETEMBRO');
      insert into financial_periods(id,financial_view_id,label,partner,logistics_partner,reference_cnpj,net_amount) values('${wrongPeriod}','${wrongId}','35. 2Q DE SETEMBRO','IMILE','IMILE','MOVIDOS',99),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','36. 2Q DE SETEMBRO','IMILE','IMILE','MOVIDOS',321);
      insert into financial_drop_items(id,financial_period_id,amount) values('cccccccc-cccc-4ccc-8ccc-cccccccccccc','${wrongPeriod}',7);
      insert into financial_payment_history select *, '35. 2Q DE SETEMBRO' from financial_drop_items where financial_period_id='${wrongPeriod}';
      insert into loss_events select * from financial_payment_history where financial_period_id='${wrongPeriod}';`)
    const correctBefore=(await database.query("select * from financial_periods where label in ('35. 1Q DE SETEMBRO','36. 2Q DE SETEMBRO') order by id")).rows
    const executeFor=id=>maintenance.replace('target_id uuid := null;',`target_id uuid := '${id}';`)
    await assert.rejects(database.exec(executeFor('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')),/titulo diferente/)
    await database.exec('rollback')
    await database.exec(executeFor(wrongId));await database.exec(executeFor(wrongId))
    assert.equal((await database.query(`select is_active from financial_views where id='${wrongId}'`)).rows[0].is_active,false)
    for(const table of ['financial_drop_items','financial_payment_history','loss_events']){
      assert.deepEqual((await database.query(`select is_active,amount from ${table} where financial_period_id='${wrongPeriod}'`)).rows,[{is_active:false,amount:'7'}])
    }
    assert.deepEqual((await database.query("select * from financial_periods where label in ('35. 1Q DE SETEMBRO','36. 2Q DE SETEMBRO') order by id")).rows,correctBefore)
    assert.equal((await database.query(`select count(*) from financial_view_changes where financial_view_id='${wrongId}'`)).rows[0].count,1)
  } finally { await database.close() }
})

test('registration and route guards reject new duplicates, preserve old data and audit CEP clearing', async () => {
  const database = new PGlite()
  try {
    await database.exec(`create role authenticated;create role anon;create schema auth;
      create function auth.uid() returns uuid language sql as $$select '11111111-1111-4111-8111-111111111111'::uuid$$;
      create function can_manage_delivery_routes() returns boolean language sql as $$select current_setting('test.allowed',true)='yes'$$;
      create table user_profiles(id uuid primary key);insert into user_profiles values(auth.uid());
      create table drops(id uuid primary key default gen_random_uuid(),name text,partner text,municipality text,registration_type text,is_active boolean default true);
      create table delivery_route_base(id uuid primary key default gen_random_uuid(),street text,neighborhood text,city text,postal_code text,zone text,route text,is_active boolean default true);
      insert into drops(name,partner,municipality) values('Teste','IMILE','Suzano');
      insert into delivery_route_base(street,neighborhood,city,zone,route,postal_code) values('Rua','Centro','Suzano','Leste','1','08600-000');`)
    const migration = await readFile('supabase/migrations/20261012110000_registration_route_guards.sql','utf8')
    await database.exec(migration);await database.exec(migration)
    await assert.rejects(database.exec("insert into drops(name,partner,municipality) values(' teste ','imile','SUZANO')"),/duplicado/)
    await database.exec("insert into drops(name,partner,municipality) values('Teste','OUTRO','Suzano')")
    await assert.rejects(database.exec("update drops set operation_started_at='2026-10-12',operation_ended_at='2026-10-01'"),/drops_operation_dates_check/)
    await database.exec("update drops set operation_started_at='2026-10-01',operation_ended_at='2026-10-12'")
    await assert.rejects(database.exec("insert into delivery_route_base(street,neighborhood,city,zone,route,postal_code) values(' RUA ','centro','Suzano','leste','1','NOVO CEP')"),/duplicado/)
    const clearing="select clear_route_postal_codes(array(select id from delivery_route_base),'Revisao dos CEPs') as count"
    await assert.rejects(database.exec(clearing),/permissao/)
    await database.exec("select set_config('test.allowed','yes',false)")
    assert.equal((await database.query(clearing)).rows[0].count,1)
    await assert.rejects(database.exec("select clear_route_postal_codes(null,'Motivo valido')"),/Selecione/)
    assert.equal((await database.query('select postal_code from delivery_route_base')).rows[0].postal_code,null)
    assert.equal((await database.query('select previous_values from route_postal_changes')).rows[0].previous_values[0].postal_code,'08600-000')
    assert.equal((await database.query(clearing)).rows[0].count,0)
    const segmentsMigration=await readFile('supabase/migrations/20261019120000_route_postal_segments.sql','utf8')
    const snapshot=(await database.query('select * from delivery_route_base order by id')).rows
    const policies=(await database.query("select * from pg_policies where tablename in ('delivery_route_base','route_postal_changes') order by policyname")).rows
    await database.exec(segmentsMigration);await database.exec(segmentsMigration)
    assert.deepEqual((await database.query('select * from delivery_route_base order by id')).rows,snapshot)
    assert.deepEqual((await database.query("select * from pg_policies where tablename in ('delivery_route_base','route_postal_changes') order by policyname")).rows,policies)
    await database.exec("insert into delivery_route_base(street,neighborhood,city,zone,route,postal_code) values('Avenida','Centro','Varzea Paulista','Oeste','Joao','13220-001'),('Avenida','Centro','Varzea Paulista','Oeste','Joao','13220-005')")
    await assert.rejects(database.exec("insert into delivery_route_base(street,neighborhood,city,zone,route,postal_code) values(' AVENIDA ','centro','Varzea Paulista','oeste','joao','13220001')"),/duplicado/)
    await assert.rejects(database.exec("update delivery_route_base set postal_code='13220-001' where postal_code='13220-005'"),/duplicado/)
    await database.exec("update delivery_route_base set route='Maria' where street='Avenida'")
    assert.equal((await database.query(clearing)).rows[0].count,2)
    assert.equal((await database.query("select count(*) from delivery_route_base where street='Avenida' and postal_code is null")).rows[0].count,2)
    await database.exec("select set_config('test.allowed','no',false)")
    await assert.rejects(database.exec(clearing),/permissao/)
  } finally {await database.close()}
})

test('invoice storage stays private and reservations preserve scope, duplicates and revoked links', async () => {
  const database=new PGlite()
  try{
    await database.exec(`create role authenticated;create role anon;create role service_role;create schema storage;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key,bucket_id text);alter table storage.objects enable row level security;
      create policy legacy_wide_policy on storage.objects for all to authenticated using(true) with check(true);grant all on storage.objects to authenticated;grant usage on schema storage to authenticated;
      create table drops(id uuid primary key);create table user_profiles(id uuid primary key);
      create table financial_views(id uuid primary key,is_active boolean default true);
      create table financial_periods(id uuid primary key,financial_view_id uuid,label text,reference_cnpj text,is_active boolean default true);
      insert into drops values('11111111-1111-4111-8111-111111111111');
      insert into financial_periods(id,label,reference_cnpj) values('22222222-2222-4222-8222-222222222222','35. 1Q','MOVIDOS');`)
    const migration=await readFile('supabase/migrations/20261012120000_financial_invoices.sql','utf8')
    await database.exec(migration);await database.exec(migration)
    await database.exec(`insert into financial_invoice_requests(id,financial_period_id,drop_id,drop_name,period_label,partner,reference_cnpj,token_hash,expires_at) values('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','DROP','35. 1Q','IMILE','MOVIDOS',repeat('a',64),now()+interval '1 day');`)
    const reserve=`insert into financial_invoice_files(request_id,client_upload_id,file_name,storage_path,content_hash,size_bytes,content_type) values('33333333-3333-4333-8333-333333333333',gen_random_uuid(),'nf.pdf','file.pdf',repeat('b',64),10,'application/pdf')`
    await database.exec(reserve)
    await assert.rejects(database.exec(reserve),/unique/)
    await database.exec("set role authenticated")
    await assert.rejects(database.exec('select * from financial_invoice_requests'),/permission denied/)
    await assert.rejects(database.exec("insert into storage.objects values(gen_random_uuid(),'financial-invoices')"),/row-level security/)
    await database.exec('reset role')
    await database.exec("update financial_periods set label='35. 2Q'")
    assert.ok((await database.query('select revoked_at from financial_invoice_requests')).rows[0].revoked_at)
    await assert.rejects(database.exec(reserve),/revogado/)
    assert.equal((await database.query('select count(*) from financial_invoice_files')).rows[0].count,1)
    assert.equal((await database.query("select public from storage.buckets where id='financial-invoices'")).rows[0].public,false)
  }finally{await database.close()}
})

test('closing import schema repair adds missing logistics columns without rewriting financial records or policies', async () => {
  const database = new PGlite()
  try {
    const schema = await readFile('supabase/schema.sql', 'utf8')
    await database.exec(`
      create role authenticated;
      create table user_profiles (id uuid primary key);
      create table drops (id uuid primary key);
      create table financial_views (id uuid primary key, title text, import_status text);
      create table financial_payment_history (id integer primary key, partner text, responsible text, total_receivable numeric, observation text);
    `)
    await database.exec(schema.slice(schema.indexOf('create table if not exists public.financial_periods'), schema.indexOf('create table if not exists public.drop_documents')))
    const viewSchema = await readFile('supabase/03_financial_views.sql', 'utf8')
    await database.exec(viewSchema.slice(viewSchema.indexOf('alter table public.financial_periods'), viewSchema.indexOf('drop trigger')))
    await database.exec(`
      insert into financial_views values ('11111111-1111-4111-8111-111111111111','Tentativa antiga','rascunho');
      insert into financial_periods (id,label,partner,reference_cnpj,net_amount,payment_date) values ('22222222-2222-4222-8222-222222222222','33. 1Q DE AGOSTO','Responsavel legado','BELLY',123.45,'2026-09-16');
      insert into financial_payment_history values (1,'J&T EXPRESS LTDA','Responsavel preservado',98.76,'Observacao preservada');
      insert into loss_events (id,financial_period_id,partner,period_label,amount,observation) values ('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','Responsavel legado','33. 1Q DE AGOSTO',12.34,'Extravio preservado');
    `)
    for (const table of ['financial_periods', 'financial_payment_history', 'loss_events', 'financial_views']) {
      await database.exec(`alter table ${table} enable row level security; create policy existing_access on ${table} for select to authenticated using (true);`)
    }
    const snapshot = async () => ({
      periods: (await database.query('select id,label,partner,reference_cnpj,net_amount,payment_date,created_at,updated_at from financial_periods order by id')).rows,
      history: (await database.query('select id,partner,responsible,total_receivable,observation from financial_payment_history order by id')).rows,
      losses: (await database.query('select id,financial_period_id,partner,period_label,amount,observation,created_at,updated_at from loss_events order by id')).rows,
      views: (await database.query('select * from financial_views order by id')).rows,
      policies: (await database.query('select tablename,policyname,roles,cmd,qual,with_check from pg_policies order by tablename,policyname')).rows,
    })
    const before = await snapshot()
    await assert.rejects(database.exec("insert into financial_periods (label,partner,logistics_partner) values ('34. 2Q DE AGOSTO','IMILE DELIVERY BRAZIL LTDA','IMILE DELIVERY BRAZIL LTDA')"), /logistics_partner.*does not exist/)
    const migration = await readFile('supabase/migrations/20260917130000_prepare_financial_logistics_columns.sql', 'utf8')
    await database.exec(migration)
    await database.exec(migration)
    assert.deepEqual(await snapshot(), before)
    assert.equal((await database.query('select logistics_partner,responsible from financial_periods')).rows[0].logistics_partner, null)
    assert.equal((await database.query('select logistics_partner,responsible from financial_periods')).rows[0].responsible, null)
    assert.equal((await database.query('select logistics_partner from financial_payment_history')).rows[0].logistics_partner, null)
    assert.equal((await database.query('select logistics_partner from loss_events')).rows[0].logistics_partner, null)
    const inserted = (await database.query("insert into financial_periods (label,partner,logistics_partner,reference_cnpj,net_amount,payment_date,financial_view_id,status) values ('34. 2Q DE AGOSTO','J&T EXPRESS LTDA','J&T EXPRESS LTDA','MOVIDOS',999.99,'2026-09-17','11111111-1111-4111-8111-111111111111','aberto') returning id,logistics_partner")).rows[0]
    await database.query('update financial_periods set responsible=$1 where id=$2', ['Novo responsavel', inserted.id])
    await database.exec(migration)
    assert.deepEqual((await database.query('select logistics_partner,responsible from financial_periods where id=$1', [inserted.id])).rows[0], { logistics_partner: 'J&T EXPRESS LTDA', responsible: 'Novo responsavel' })
    assert.deepEqual((await snapshot()).policies, before.policies)
    assert.ok((await database.query("select relrowsecurity from pg_class where relname in ('financial_periods','financial_payment_history','loss_events','financial_views')")).rows.every(row => row.relrowsecurity))
  } finally { await database.close() }
})

test('Last Mile vehicle migration preserves PIX and partner constraints while allowing an unselected partner', async () => {
  const database = new PGlite()
  try {
    await build({ entryPoints: ['src/dropOptions.ts'], outfile: 'tmp/database-tests/last-mile-options.cjs', bundle: true, platform: 'node', format: 'cjs' })
    const { PARTNERS, VEHICLE_TYPES, PIX_KEY_TYPES } = await import(pathToFileURL(`${process.cwd()}/tmp/database-tests/last-mile-options.cjs`).href)
    await database.exec(`
      create role authenticated;
      create table public.drops (id integer primary key, partner text, pix_key_type text, pix_key text, vehicle_plate text);
      alter table public.drops enable row level security;
      create policy existing_drop_access on public.drops for select to authenticated using (true);
      insert into public.drops values (1,null,'CPF','test-key','ABC1D23');
    `)
    const partnerSchema = await readFile('supabase/migrations/20260914130000_restore_drop_partners.sql', 'utf8')
    await database.exec(`alter table public.drops ${partnerSchema.match(/add constraint drops_partner_check[\s\S]+?;/)[0]}`)
    const before = (await database.query('select * from drops')).rows[0]
    const policiesBefore = (await database.query("select policyname,qual,with_check from pg_policies where tablename='drops'")).rows
    const migration = await readFile('supabase/migrations/20260917100000_add_last_mile_vehicle_type.sql', 'utf8')
    await database.exec(migration)
    await database.exec(migration)
    assert.deepEqual((await database.query('select * from drops')).rows[0], { ...before, vehicle_type: null })
    assert.deepEqual((await database.query("select policyname,qual,with_check from pg_policies where tablename='drops'")).rows, policiesBefore)
    assert.equal((await database.query("select relrowsecurity from pg_class where relname='drops'")).rows[0].relrowsecurity, true)
    await assert.rejects(database.exec("insert into drops (id,partner) values (2,'')"), /drops_partner_check/)
    await assert.rejects(database.exec("insert into drops (id,partner) values (2,'PARCEIRO INVALIDO')"), /drops_partner_check/)
    assert.equal((await database.query("insert into drops (id,partner,vehicle_type,pix_key_type) values (2,null,'Moto','CPF') returning partner")).rows[0].partner, null)
    for (const partner of PARTNERS) await database.query('update drops set partner=$1 where id=2', [partner])
    for (const vehicleType of VEHICLE_TYPES) {
      assert.ok(!PIX_KEY_TYPES.includes(vehicleType))
      await database.query('update drops set vehicle_type=$1 where id=2', [vehicleType])
    }
    assert.equal((await database.query('select pix_key_type from drops where id=2')).rows[0].pix_key_type, 'CPF')
    await database.exec(migration)
    assert.deepEqual((await database.query('select * from drops where id=1')).rows[0], { ...before, vehicle_type: null })
    assert.equal((await database.query('select vehicle_type from drops where id=2')).rows[0].vehicle_type, VEHICLE_TYPES.at(-1))
  } finally { await database.close() }
})

test('employee RLS recovery restores delegated saves without granting access or deleting history', async () => {
  const database = new PGlite()
  try {
    await database.exec(`
      create role authenticated;
      create role anon;
      create schema auth;
      create function auth.uid() returns text language sql stable as $$ select current_setting('test.user') $$;
      create table user_profiles (id text primary key, role text, is_active boolean);
      create table user_module_permissions (user_id text primary key, funcionarios_view boolean, funcionarios_manage boolean);
      insert into user_profiles values ('admin','admin',true), ('manager','operador',true), ('manage_only','operador',true), ('viewer','operador',true), ('operator','operador',true), ('inactive','admin',false), ('inactive_manager','operador',false);
      insert into user_module_permissions values ('manager',true,true), ('manage_only',false,true), ('viewer',true,false), ('operator',false,false), ('inactive',true,true), ('inactive_manager',true,true);
      create function is_active_user() returns boolean language sql stable security definer as $$ select coalesce((select is_active from user_profiles where id=auth.uid()),false) $$;
      create function is_admin() returns boolean language sql stable security definer as $$ select coalesce((select role='admin' and is_active from user_profiles where id=auth.uid()),false) $$;
      create table employees (id integer primary key, full_name text);
      create table employee_dependents (id integer primary key, employee_id integer references employees(id), is_active boolean default true, deactivated_reason text);
      alter table employees enable row level security;
      alter table employee_dependents enable row level security;
      insert into employees values (10,'Registro preservado');
      insert into employee_dependents (id,employee_id) values (10,10);
      create policy custom_employee_guard on employees as restrictive for insert to authenticated with check (id <> 99);
      grant usage on schema public,auth to authenticated,anon;
      grant select,insert,update,delete on employees,employee_dependents to authenticated,anon;
    `)
    const legacy = await readFile('supabase/04_employees.sql', 'utf8')
    const permissions = await readFile('supabase/05_user_permissions.sql', 'utf8')
    await database.exec(permissions.match(/create or replace function public\.has_module_permission[\s\S]+?\$\$;/)[0])
    await database.exec(legacy.slice(legacy.indexOf('drop policy if exists "employees_admin_only"'), legacy.indexOf('-- Ao criar uma conta')))
    await database.exec("set role authenticated; select set_config('test.user','manager',false)")
    assert.equal((await database.query("select has_module_permission('funcionarios_manage') as allowed")).rows[0].allowed, true)
    await assert.rejects(database.exec("insert into employees values (1,'Teste autorizado')"), /row-level security/)
    await database.exec('reset role')
    const snapshot = async () => ({
      profiles: (await database.query('select * from user_profiles order by id')).rows,
      permissions: (await database.query('select * from user_module_permissions order by user_id')).rows,
      employees: (await database.query('select * from employees order by id')).rows,
      dependents: (await database.query('select * from employee_dependents order by id')).rows,
    })
    const before = await snapshot()
    const migration = await readFile('supabase/migrations/20260916050000_restore_employee_module_policies.sql', 'utf8')
    await database.exec(migration)
    await database.exec(migration)
    assert.deepEqual(await snapshot(), before)
    assert.equal((await database.query("select policyname from pg_policies where policyname='custom_employee_guard'")).rows.length, 1)
    assert.ok((await database.query("select relrowsecurity from pg_class where relname in ('employees','employee_dependents')")).rows.every(row => row.relrowsecurity))
    await database.exec("set role authenticated; select set_config('test.user','manager',false)")
    assert.equal((await database.query("insert into employees values (1,'Teste autorizado') returning id")).rows[0].id, 1)
    await database.exec('insert into employee_dependents (id,employee_id) values (1,1)')
    assert.equal((await database.query("update employees set full_name='Atualizado' where id=1 returning id")).rows.length, 1)
    assert.equal((await database.query("update employee_dependents set is_active=false,deactivated_reason='Motivo preservado' where id=1 returning id")).rows.length, 1)
    for (const [index, allowed] of ['admin', 'manage_only'].entries()) {
      await database.query("select set_config('test.user',$1,false)", [allowed])
      assert.equal((await database.query('insert into employees values ($1,$2) returning id', [20 + index, 'Autorizado'])).rows.length, 1)
      assert.equal((await database.query('insert into employee_dependents (id,employee_id) values ($1,$1) returning id', [20 + index])).rows.length, 1)
      assert.equal((await database.query('delete from employee_dependents where id=10 returning id')).rows.length, 0)
      assert.equal((await database.query('delete from employees where id=10 returning id')).rows.length, 0)
      await assert.rejects(database.exec("insert into employees values (99,'Restricao adicional preservada')"), /row-level security/)
    }
    for (const denied of ['viewer', 'operator', 'inactive', 'inactive_manager', 'missing_profile']) {
      await database.query("select set_config('test.user',$1,false)", [denied])
      assert.equal((await database.query('select id from employees')).rows.length > 0, denied === 'viewer')
      assert.equal((await database.query('select id from employee_dependents')).rows.length > 0, denied === 'viewer')
      await assert.rejects(database.exec("insert into employees values (2,'Bloqueado')"), /row-level security/)
      await assert.rejects(database.exec('insert into employee_dependents (id,employee_id) values (2,1)'), /row-level security/)
      assert.equal((await database.query("update employees set full_name='Bloqueado' where id=10 returning id")).rows.length, 0)
      assert.equal((await database.query('update employee_dependents set is_active=false where id=10 returning id')).rows.length, 0)
    }
    await database.exec("reset role; set role anon; select set_config('test.user','admin',false)")
    assert.equal((await database.query('select * from employees')).rows.length, 0)
    await assert.rejects(database.exec("insert into employees values (2,'Anonimo')"), /row-level security/)
    await database.exec('reset role')
    const after = await snapshot()
    assert.deepEqual(after.profiles, before.profiles)
    assert.deepEqual(after.permissions, before.permissions)
    assert.deepEqual(after.employees.find(row => row.id === 10), before.employees[0])
    assert.deepEqual(after.dependents.find(row => row.id === 10), before.dependents[0])
  } finally { await database.close() }
})

test('registration status values satisfy the real SQL constraint and deactivate without deleting the record', async () => {
  const database = new PGlite()
  try {
    await build({ entryPoints: ['src/dropOptions.ts'], outfile: 'tmp/database-tests/drop-options.cjs', bundle: true, platform: 'node', format: 'cjs' })
    const { DROP_STATUSES } = await import(pathToFileURL(`${process.cwd()}/tmp/database-tests/drop-options.cjs`).href)
    const schema = await readFile('supabase/schema.sql', 'utf8')
    const statusColumn = schema.match(/status text not null default 'INTERESSADO' check \(status in \([^\n]+\)\)/)[0]
    await database.exec(`create table drops (id integer primary key, ${statusColumn}, is_active boolean not null, deactivated_reason text, deactivated_at timestamptz, deactivated_by text); insert into drops values (1,'ATIVO',true,null,null,null)`)
    const invalidStatus = Buffer.from('EXCLUÍDO', 'utf8').toString('latin1')
    await assert.rejects(database.query('update drops set status=$1,is_active=false,deactivated_reason=$2 where id=1', [invalidStatus, 'Encerramento']), /check constraint/)
    assert.deepEqual((await database.query('select status,is_active,deactivated_reason from drops')).rows, [{ status: 'ATIVO', is_active: true, deactivated_reason: null }])
    for (const status of DROP_STATUSES) await database.query('update drops set status=$1 where id=1', [status])
    await database.query('update drops set status=$1,is_active=false,deactivated_reason=$2,deactivated_at=now(),deactivated_by=$3 where id=1', ['EXCLUÍDO', 'Encerramento solicitado', 'test-user'])
    assert.deepEqual((await database.query('select id,status,is_active,deactivated_reason,deactivated_by from drops')).rows, [{ id: 1, status: 'EXCLUÍDO', is_active: false, deactivated_reason: 'Encerramento solicitado', deactivated_by: 'test-user' }])
  } finally { await database.close() }
})

test('financial email policies and identity migration preserve data and deny unauthorized access', async () => {
  const database = new PGlite()
  try {
    await database.exec(`
      create role authenticated;
      create table user_profiles (id text primary key, role text, is_active boolean);
      create table user_module_permissions (user_id text, financeiro_view boolean, financeiro_manage boolean);
      insert into user_profiles values ('admin','admin',true), ('finance','financeiro',true), ('operator','operador',true), ('inactive','admin',false);
      insert into user_module_permissions values ('finance',true,true), ('operator',false,false);
      create function is_active_user() returns boolean language sql stable security definer as $$ select coalesce((select is_active from user_profiles where id=current_setting('test.user')),false) $$;
      create function is_admin() returns boolean language sql stable security definer as $$ select coalesce((select role='admin' and is_active from user_profiles where id=current_setting('test.user')),false) $$;
      create function has_module_permission(permission_name text) returns boolean language sql stable security definer as $$ select is_admin() or coalesce((select case when permission_name='financeiro_view' then financeiro_view else financeiro_manage end from user_module_permissions where user_id=current_setting('test.user')),false) $$;
      create table email_templates (key text primary key, subject text, body text);
      create table email_logs (id integer, subject text);
      create table app_notes (key text primary key, content text);
      alter table email_templates enable row level security;
      alter table email_logs enable row level security;
      alter table app_notes enable row level security;
      create policy email_templates_read on email_templates for select to authenticated using (is_active_user());
      create policy email_templates_admin_write on email_templates for all to authenticated using (is_admin()) with check (is_admin());
      create policy email_logs_read on email_logs for select to authenticated using (is_active_user());
      create policy app_notes_read on app_notes for select to authenticated using (is_active_user());
      create policy app_notes_write on app_notes for all to authenticated using (is_active_user()) with check (is_active_user());
      insert into email_templates values ('ready-message-initial','Atendimento','publico'), ('financial_closing','Financeiro','privado');
      insert into email_logs values (1,'Fechamento privado');
      insert into app_notes values ('general','publico'), ('financial','privado'), ('ready_messages_draft','rascunho');
      create table financial_periods (id text primary key, label text, partner text, reference_cnpj text, payment_date date, net_amount numeric, unique(label,partner));
      create table financial_payment_history (id text primary key, financial_period_id text references financial_periods(id), partner text, responsible text, total_receivable numeric);
      create table loss_events (id text primary key, financial_period_id text references financial_periods(id), partner text, amount numeric);
      insert into financial_periods values ('p1','SETEMBRO','Eduardo',null,'2026-09-15',100), ('p2','SETEMBRO','Felipe','BELLY','2026-09-16',200);
      insert into financial_payment_history values ('h1','p1','Eduardo',null,50), ('h2','p2','Felipe',null,70);
      insert into loss_events values ('l1','p1','Eduardo',10), ('l2','p2','Felipe',20);
      grant usage on schema public to authenticated;
      grant select,insert,update,delete on email_templates,email_logs,app_notes to authenticated;
    `)
    for (const file of ['20260916010000_isolate_financial_emails.sql', '20260916011000_financial_logistics_partner.sql']) {
      await database.exec(await readFile(`supabase/migrations/${file}`, 'utf8'))
    }
    const preserved = await database.query('select id,partner,responsible,logistics_partner,reference_cnpj,net_amount from financial_periods order by id')
    assert.deepEqual(preserved.rows.map(row => [row.id, row.partner, row.responsible, row.logistics_partner, row.reference_cnpj, Number(row.net_amount)]), [
      ['p1', 'Eduardo', 'Eduardo', 'IMILE DELIVERY BRAZIL LTDA', 'MOVIDOS', 100],
      ['p2', 'Felipe', 'Felipe', 'IMILE DELIVERY BRAZIL LTDA', 'MOVIDOS', 200],
    ])
    assert.deepEqual((await database.query('select financial_period_id,amount from loss_events order by id')).rows.map(row => [row.financial_period_id, Number(row.amount)]), [['p1', 10], ['p2', 20]])
    await database.exec("set role authenticated; select set_config('test.user','operator',false);")
    assert.deepEqual((await database.query('select key from email_templates')).rows, [{ key: 'ready-message-initial' }])
    assert.equal((await database.query('select * from email_logs')).rows.length, 0)
    assert.equal((await database.query("select * from app_notes where key='financial'")).rows.length, 0)
    await assert.rejects(database.query("insert into email_templates values ('financial_secret','segredo','privado')"), /row-level security/)
    await database.exec("update app_notes set content='Rascunho salvo' where key='ready_messages_draft'")
    assert.equal((await database.query("select content from app_notes where key='ready_messages_draft'")).rows[0].content, 'Rascunho salvo')
    await database.exec("select set_config('test.user','finance',false);")
    assert.equal((await database.query('select * from email_templates')).rows.length, 2)
    assert.equal((await database.query('select * from email_logs')).rows.length, 1)
    await database.exec("update email_templates set body='Financeiro atualizado' where key='financial_closing'")
    assert.equal((await database.query("select body from email_templates where key='financial_closing'")).rows[0].body, 'Financeiro atualizado')
    await database.exec("select set_config('test.user','inactive',false);")
    assert.equal((await database.query('select * from email_templates')).rows.length, 0)
    assert.equal((await database.query('select * from email_logs')).rows.length, 0)
  } finally { await database.close() }
})

test('contract template storage stays admin-only without restricting registration attachments', async () => {
  const database = new PGlite()
  try {
    await database.exec(`
      create role authenticated;
      create schema storage;
      create table storage.objects (name text primary key, bucket_id text, content text);
      create function public.is_admin() returns boolean language sql stable as $$ select current_setting('test.user')='admin' $$;
      alter table storage.objects enable row level security;
      create policy existing_access on storage.objects for all to authenticated using (current_setting('test.user')<>'inactive') with check (current_setting('test.user')<>'inactive');
      grant usage on schema public,storage to authenticated;
      grant select,insert,update,delete on storage.objects to authenticated;
      insert into storage.objects values ('contract-templates/config.json','movidos-documents','config'), ('contract-templates/service/original.docx','movidos-documents','original'), ('drops/last-mile/fotos/fachada.png','movidos-documents','photo');
    `)
    const before = (await database.query('select * from storage.objects order by name')).rows
    const migration = await readFile('supabase/migrations/20260916040000_protect_contract_templates.sql', 'utf8')
    await database.exec(migration)
    await database.exec(migration)
    assert.deepEqual((await database.query('select * from storage.objects order by name')).rows, before)
    await database.exec("set role authenticated; select set_config('test.user','operator',false)")
    await assert.rejects(database.exec("insert into storage.objects values ('contract-templates/service/forged.docx','movidos-documents','forged')"), /row-level security/)
    assert.equal((await database.query("update storage.objects set content='forged' where name like 'contract-templates/%' returning name")).rows.length, 0)
    assert.equal((await database.query("delete from storage.objects where name like 'contract-templates/%' returning name")).rows.length, 0)
    await assert.rejects(database.exec("update storage.objects set name='contract-templates/service/moved.docx' where name='drops/last-mile/fotos/fachada.png'"), /row-level security/)
    await database.exec("insert into storage.objects values ('drops/last-mile/contratos/signed.pdf','movidos-documents','contract')")
    assert.equal((await database.query("update storage.objects set content='changed' where name='drops/last-mile/contratos/signed.pdf' returning name")).rows.length, 1)
    await database.exec("select set_config('test.user','admin',false)")
    await database.exec("insert into storage.objects values ('contract-templates/service/new.docx','movidos-documents','new')")
    assert.equal((await database.query("update storage.objects set content='new config' where name='contract-templates/config.json' returning name")).rows.length, 1)
    assert.equal((await database.query("delete from storage.objects where name='contract-templates/service/new.docx' returning name")).rows.length, 1)
    await database.exec("select set_config('test.user','inactive',false)")
    await assert.rejects(database.exec("insert into storage.objects values ('contract-templates/service/disabled.docx','movidos-documents','disabled')"), /row-level security/)
  } finally { await database.close() }
})

test('direct mail reservations are unique and cannot be forged by browser clients', async () => {
  const database = new PGlite()
  try {
    await database.exec(`
      create role authenticated;
      create function is_active_user() returns boolean language sql as $$ select true $$;
      create function has_module_permission(permission_name text) returns boolean language sql as $$ select true $$;
      create table email_logs (id integer, status text constraint email_logs_status_check check (status in ('enviado','preparado','erro')));
      insert into email_logs values (1,'enviado');
      alter table email_logs enable row level security;
      create policy email_logs_admin on email_logs for all to authenticated using (true) with check (true);
      grant usage on schema public to authenticated;
      grant select,insert on email_logs to authenticated;
    `)
    await database.exec(await readFile('supabase/migrations/20260916020000_direct_closing_email.sql', 'utf8'))
    await database.exec("insert into email_logs values (2,'enviando','unique-key')")
    await assert.rejects(database.exec("insert into email_logs values (3,'enviando','unique-key')"), /unique/)
    assert.equal((await database.query('select status from email_logs where id=1')).rows[0].status, 'enviado')
    await database.exec('set role authenticated')
    await assert.rejects(database.exec("insert into email_logs values (4,'enviando','forged-key')"), /row-level security/)
    await assert.rejects(database.exec("insert into email_logs values (5,'aceito',null)"), /row-level security/)
    await database.exec("insert into email_logs values (6,'preparado',null)")
  } finally { await database.close() }
})

test('historical net recovery restores 33 totals, preserves existing records and rejects conflicts atomically', async () => {
  const database = new PGlite()
  await build({ entryPoints: ['src/financialData.ts'], outfile: 'tmp/database-tests/financial.cjs', bundle: true, platform: 'node', format: 'cjs' })
  const { buildTotals } = await import(pathToFileURL(`${process.cwd()}/tmp/database-tests/financial.cjs`).href)
  const migration = await readFile('supabase/migrations/20260916030000_recover_historical_net.sql', 'utf8')
  try {
    await database.exec(`
      create table financial_views (id integer primary key, title text, source_file_name text, is_active boolean, notes text);
      create table financial_periods (id integer primary key, financial_view_id integer references financial_views(id), label text, partner text, is_active boolean, net_amount numeric, payment_date date);
    `)
    await database.exec(migration)
    const months = ['ABRIL','MAIO','JUNHO','JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO','JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO','JULHO','AGOSTO']
    for (let index = 0; index < 33; index++) {
      const label = `${String(index + 1).padStart(2, '0')}. ${index % 2 + 1}Q DE ${months[Math.floor(index / 2)]}`
      await database.query('insert into financial_views values ($1,$2,$3,true,$4)', [index + 1, label, '0000 - CONTROLE FINANCEIRO com macro.xlsx', index === 32 ? JSON.stringify({ reimbursement: 17, summary: { custom: 'preserve' } }) : 'Historico original'])
      for (const offset of [0, 100]) await database.query('insert into financial_periods values ($1,$2,$3,$4,true,null,null)', [index + 1 + offset, index + 1, label, 'IMILE DELIVERY BRAZIL LTDA'])
    }
    await database.exec("insert into financial_views values (99,'OUTRO','outro.xlsx',true,'intocado')")
    const beforePeriods = (await database.query('select * from financial_periods order by id')).rows
    await database.exec(migration)
    const views = (await database.query('select * from financial_views order by id')).rows
    const totals = buildTotals([], [{ financial_period_id: 33, status: 'PUDO Missing', amount: 25107.22 }, { financial_period_id: 33, status: 'D2D Missing - não cobrei', amount: 6242.14 }], beforePeriods, views)
    assert.equal(totals.length, 33)
    assert.ok(totals.every(row => !row.missingNet))
    assert.equal(Math.round(totals.reduce((sum, row) => sum + row.net, 0) * 100) / 100, 2150390.90)
    assert.equal(totals[32].net, 153227.51)
    assert.equal(totals[32].gross, 184576.87)
    assert.equal(totals[32].reimbursement, 17)
    assert.equal(totals[32].paymentDate, '2026-09-16')
    assert.equal(JSON.parse(views[0].notes).originalNotes, 'Historico original')
    assert.equal(JSON.parse(views[32].notes).summary.custom, 'preserve')
    assert.equal(views[33].notes, 'intocado')
    assert.deepEqual((await database.query('select * from financial_periods order by id')).rows, beforePeriods)
    await database.exec(migration)
    assert.deepEqual((await database.query('select * from financial_views order by id')).rows, views)
    await database.query('update financial_views set notes=$1 where id=33', [JSON.stringify({ summary: { invoice: 0 } })])
    await database.exec("update financial_views set notes='Restaurar depois' where id=1")
    await assert.rejects(database.exec(migration), /Resumo divergente/)
    await database.exec('rollback')
    assert.equal((await database.query('select notes from financial_views where id=1')).rows[0].notes, 'Restaurar depois')
    assert.equal(JSON.parse((await database.query('select notes from financial_views where id=33')).rows[0].notes).summary.invoice, 0)
  } finally { await database.close() }
})

test('missing permission helper is restored without granting access or replacing an existing implementation', async () => {
  const database = new PGlite()
  try {
    await database.exec(`
      create role authenticated;
      create schema auth;
      create function auth.uid() returns text language sql stable as $$ select current_setting('test.user') $$;
      create table user_profiles (id text primary key, role text, is_active boolean);
      create table user_module_permissions (user_id text primary key, financeiro_manage boolean, financeiro_view boolean);
      insert into user_profiles values ('admin','admin',true), ('finance','financeiro',true), ('operator','operador',true), ('inactive','admin',false), ('missing','operador',true);
      insert into user_module_permissions values ('finance',true,true), ('operator',false,false), ('inactive',true,true);
      create function is_active_user() returns boolean language sql stable security definer as $$ select exists(select 1 from user_profiles where id=auth.uid() and is_active) $$;
      create function is_admin() returns boolean language sql stable security definer as $$ select exists(select 1 from user_profiles where id=auth.uid() and is_active and role='admin') $$;
      create table email_logs (status text);
      alter table email_logs enable row level security;
      grant usage on schema public,auth to authenticated;
    `)
    const migration = await readFile('supabase/migrations/20260916015000_restore_permission_helper.sql', 'utf8')
    const before = (await database.query('select * from user_module_permissions order by user_id')).rows
    await database.exec(migration)
    await database.exec(await readFile('supabase/migrations/20260916020000_direct_closing_email.sql', 'utf8'))
    await database.exec('set role authenticated')
    for (const [user, allowed] of [['admin', true], ['finance', true], ['operator', false], ['inactive', false], ['missing', false]]) {
      await database.query("select set_config('test.user',$1,false)", [user])
      assert.equal((await database.query("select has_module_permission('financeiro_manage') as allowed")).rows[0].allowed, allowed)
    }
    await database.exec('reset role')
    assert.deepEqual((await database.query('select * from user_module_permissions order by user_id')).rows, before)
    await database.exec("create or replace function has_module_permission(permission_name text) returns boolean language sql as $$ select false $$")
    await database.exec(migration)
    await database.exec("select set_config('test.user','admin',false)")
    assert.equal((await database.query("select has_module_permission('financeiro_manage') as allowed")).rows[0].allowed, false)
  } finally { await database.close() }
})