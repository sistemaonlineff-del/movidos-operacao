import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

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