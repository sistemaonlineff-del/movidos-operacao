import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

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