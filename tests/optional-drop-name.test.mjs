import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const previousMigration = await readFile(new URL('../supabase/migrations/20261014130000_registration_operation_successors.sql', import.meta.url), 'utf8')
const migration = await readFile(new URL('../supabase/migrations/20261023140000_optional_drop_name.sql', import.meta.url), 'utf8')

async function withDatabase(run) {
  const database = new PGlite()
  try {
    await database.exec(`
      create role authenticated;
      create role anon;
      create table public.drops (
        id uuid primary key default gen_random_uuid(),
        name text not null,
        partner text not null,
        municipality text not null,
        registration_type text,
        is_active boolean not null default true,
        responsible text,
        operation_started_at date,
        operation_ended_at date
      );
      alter table public.drops enable row level security;
      create policy drops_read on public.drops for select to authenticated using (true);
      create policy drops_insert on public.drops for insert to authenticated
        with check (current_setting('test.can_manage',true)='yes');
      create policy drops_update on public.drops for update to authenticated
        using (current_setting('test.can_manage',true)='yes')
        with check (current_setting('test.can_manage',true)='yes');
      create policy drops_restriction on public.drops as restrictive for all to authenticated
        using (current_setting('test.blocked',true) is distinct from 'yes')
        with check (current_setting('test.blocked',true) is distinct from 'yes');
      grant select,insert,update on public.drops to authenticated;
      create table public.financial_drop_items (id integer primary key, amount numeric, registration_snapshot jsonb);
      alter table public.financial_drop_items enable row level security;
      create policy finance_read on public.financial_drop_items for select to authenticated using (true);
      grant select on public.financial_drop_items to authenticated;
      insert into public.financial_drop_items values (1,123.45,'{"name":"Original","responsible":"Historico"}');
    `)
    await database.exec(previousMigration)
    await run(database)
  } finally {
    await database.close()
  }
}

async function snapshot(database) {
  return {
    drops: (await database.query('select * from public.drops order by id')).rows,
    financial: (await database.query('select * from public.financial_drop_items order by id')).rows,
    policies: (await database.query('select * from pg_policies order by schemaname,tablename,policyname')).rows,
    grants: (await database.query("select * from information_schema.table_privileges where table_schema='public' order by table_name,grantee,privilege_type")).rows,
    columns: (await database.query("select table_name,column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema='public' order by table_name,ordinal_position")).rows,
    constraints: (await database.query("select conname,convalidated,pg_get_constraintdef(oid) as definition from pg_constraint where connamespace='public'::regnamespace order by conname")).rows,
    security: (await database.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r' order by relname")).rows,
    triggers: (await database.query("select oid,pg_get_triggerdef(oid) as definition from pg_trigger where tgrelid='public.drops'::regclass and not tgisinternal order by tgname")).rows,
    functions: (await database.query("select oid,proname,proowner,proacl,prosecdef,proconfig from pg_proc where oid in ('public.guard_drop_duplicate()'::regprocedure,'public.registration_identity(text)'::regprocedure) order by proname")).rows,
    normalization: (await database.query("select pg_get_functiondef('public.registration_identity(text)'::regprocedure) as definition")).rows,
  }
}

test('optional name migration is repeatable without rewriting rows, schema, permissions or triggers', async () => {
  await withDatabase(async database => {
    await database.exec(`
      insert into drops(name,partner,municipality,responsible) values ('','IMILE','Suzano','Sem nome');
      insert into drops(name,partner,municipality,responsible,operation_started_at,operation_ended_at,is_active)
        values ('Ponto antigo','IMILE','Suzano','Historico','2026-09-01','2026-09-30',false);
    `)
    const previousGuard = (await database.query("select pg_get_functiondef('public.guard_drop_duplicate()'::regprocedure) as definition")).rows[0].definition.replaceAll('\r\n', '\n')
    const before = await snapshot(database)
    for (let repeat = 0; repeat < 2; repeat++) {
      await database.exec(migration)
      assert.deepEqual(await snapshot(database), before)
    }
    const originalGuard = (await database.query("select pg_get_functiondef('public.guard_drop_duplicate()'::regprocedure) as definition")).rows[0].definition.replaceAll('\r\n', '\n')
    const blankGuard = "  if public.registration_identity(new.name)='' then return new; end if;\n"
    assert.ok(originalGuard.includes(blankGuard))
    assert.equal(originalGuard.replace(blankGuard, ''), previousGuard)
    await database.exec(migration)
    assert.deepEqual(await snapshot(database), before)
    await database.exec("insert into drops(name,partner,municipality) values ('','IMILE','Suzano')")
    const afterInsert = await snapshot(database)
    await database.exec(migration)
    assert.deepEqual(await snapshot(database), afterInsert)
  })
})

test('empty normalized names allow repeated inserts and identity/date/status updates', async () => {
  await withDatabase(async database => {
    await database.exec("insert into drops(name,partner,municipality) values ('','IMILE','Suzano')")
    const insertBlank = "insert into drops(name,partner,municipality) values ('','IMILE','Suzano')"
    await assert.rejects(database.exec(insertBlank), { code: '23505' })
    await database.exec(migration)
    await database.exec(insertBlank)
    await database.exec(insertBlank)
    await database.exec(`
      insert into drops(name,partner,municipality,operation_started_at,operation_ended_at)
        values (E' \t  ','IMILE','Suzano','2026-10-01','2026-10-31');
      insert into drops(name,partner,municipality) values ('Temporario','IMILE','Suzano');
      update drops set name='' where name='Temporario';
      update drops set operation_started_at='2026-10-01',operation_ended_at='2026-10-31';
      update drops set name=' ',partner='OUTRO',municipality='Outra',registration_type='last_mile',is_active=false;
      update drops set name='',partner='IMILE',municipality='Suzano',registration_type=null,is_active=true;
    `)
    assert.equal((await database.query("select count(*) from drops where name='' and is_active and operation_started_at='2026-10-01'")).rows[0].count, 5)
    const before = await snapshot(database)
    await database.exec(migration)
    assert.deepEqual(await snapshot(database), before)
    for (const statement of [
      "insert into drops(name,partner,municipality) values (null,'IMILE','Suzano')",
      'update drops set name=null',
      "insert into drops(name,partner,municipality) values ('',null,'Suzano')",
      'update drops set municipality=null',
    ]) await assert.rejects(database.exec(statement), { code: '23502' })
  })
})

test('filled names still reject normalized duplicates and use all identity dimensions', async () => {
  await withDatabase(async database => {
    await database.exec(migration)
    const accentedName = 'P' + String.fromCharCode(0x00f3) + 'nto  Um'
    await database.query('insert into drops(name,partner,municipality) values ($1,$2,$3)', [accentedName, 'IMILE', 'Suzano'])
    await assert.rejects(database.exec("insert into drops(name,partner,municipality,registration_type) values (' ponto   um ',' imile ','SUZANO','drop_off')"), { code: '23505' })
    await database.exec("insert into drops(name,partner,municipality) values ('','IMILE','Suzano'),('Outro','IMILE','Suzano')")
    await assert.rejects(database.exec("update drops set name='PONTO UM' where name in ('','Outro')"), { code: '23505' })
    await database.exec(`
      insert into drops(name,partner,municipality) values ('PONTO UM','OUTRO','Suzano'),('PONTO UM','IMILE','Outra');
      insert into drops(name,partner,municipality,registration_type) values ('PONTO UM','IMILE','Suzano','last_mile');
      insert into drops(name,partner,municipality,is_active) values ('PONTO UM','IMILE','Suzano',false);
      update drops set responsible='Correcao sem mudar identidade';
      update drops set name=upper(name);
    `)
    await assert.rejects(database.exec("update drops set is_active=true where not is_active"), { code: '23505' })
    await assert.rejects(database.exec("update drops set partner='IMILE' where partner='OUTRO'"), { code: '23505' })
    await assert.rejects(database.exec("update drops set municipality='Suzano' where municipality='Outra'"), { code: '23505' })
    await assert.rejects(database.exec("update drops set registration_type='drop_off' where registration_type='last_mile'"), { code: '23505' })
  })
})

test('filled-name successors keep inclusive non-overlap rules including inactive dated history', async () => {
  await withDatabase(async database => {
    await database.exec(migration)
    await database.exec(`
      insert into drops(name,partner,municipality,responsible,operation_started_at,operation_ended_at,is_active)
        values ('MGC 5','IMILE','Suzano','Anterior','2026-08-01','2026-10-10',false);
      insert into drops(name,partner,municipality,responsible,operation_started_at)
        values (' mgc 5 ','imile','SUZANO','Sucessor','2026-10-11');
    `)
    for (const statement of [
      "insert into drops(name,partner,municipality,operation_started_at) values ('MGC 5','IMILE','Suzano','2026-10-10')",
      "insert into drops(name,partner,municipality) values ('MGC 5','IMILE','Suzano')",
      "insert into drops(name,partner,municipality,operation_started_at,operation_ended_at,is_active) values ('MGC 5','IMILE','Suzano','2026-10-01','2026-10-12',false)",
      "update drops set operation_started_at='2026-10-10' where responsible='Sucessor'",
      "update drops set operation_ended_at='2026-10-11' where responsible='Anterior'",
    ]) await assert.rejects(database.exec(statement), { code: '23505' })
    await database.exec(`
      update drops set operation_ended_at='2026-10-31' where responsible='Sucessor';
      insert into drops(name,partner,municipality,responsible,operation_started_at)
        values ('MGC 5','IMILE','Suzano','Proximo','2026-11-01');
      update drops set operation_ended_at='2026-09-30' where responsible='Anterior';
    `)
    assert.equal((await database.query('select count(*) from drops')).rows[0].count, 3)
  })
})

test('empty and filled names still reject inverted dates on insert and update', async () => {
  await withDatabase(async database => {
    await database.exec(migration)
    for (const name of ['', '   ', 'Com nome']) {
      for (const isActive of [true, false]) {
        await assert.rejects(database.query(`insert into drops(name,partner,municipality,is_active,operation_started_at,operation_ended_at)
          values ($1,'IMILE','Suzano',$2,'2026-10-31','2026-10-01')`, [name, isActive]), { code: '23514' })
      }
    }
    await database.exec("insert into drops(name,partner,municipality) values ('','IMILE','Suzano'),('Com nome','IMILE','Suzano')")
    for (const name of ['', 'Com nome']) {
      await assert.rejects(database.query("update drops set operation_started_at='2026-10-31',operation_ended_at='2026-10-01' where name=$1", [name]), { code: '23514' })
      await database.query("update drops set operation_started_at='2026-10-01',operation_ended_at='2026-10-01' where name=$1", [name])
      await assert.rejects(database.query("update drops set operation_ended_at='2026-09-30' where name=$1", [name]), { code: '23514' })
    }
    await database.exec("update drops set operation_started_at=null; update drops set operation_ended_at=null")
    assert.equal((await database.query('select count(*) from drops where operation_started_at is null and operation_ended_at is null')).rows[0].count, 2)
  })
})

test('optional names do not bypass manager, viewer, anonymous or restrictive RLS rules', async () => {
  await withDatabase(async database => {
    await database.exec(migration)
    await database.exec("set role anon")
    await assert.rejects(database.exec("insert into drops(name,partner,municipality) values ('','IMILE','Suzano')"), { code: '42501' })
    await database.exec("reset role; set role authenticated; select set_config('test.can_manage','no',false)")
    await assert.rejects(database.exec("insert into drops(name,partner,municipality) values ('','IMILE','Suzano')"), { code: '42501' })
    await database.exec("select set_config('test.can_manage','yes',false)")
    await database.exec("insert into drops(name,partner,municipality) values ('','IMILE','Suzano'),('','IMILE','Suzano')")
    await database.exec("update drops set responsible='Gerente autorizado',operation_started_at='2026-10-01'")
    await database.exec("select set_config('test.can_manage','no',false)")
    assert.equal((await database.query("update drops set responsible='Negado' returning id")).rows.length, 0)
    await database.exec("select set_config('test.can_manage','yes',false); select set_config('test.blocked','yes',false)")
    await assert.rejects(database.exec("insert into drops(name,partner,municipality) values ('','IMILE','Suzano')"), { code: '42501' })
    assert.equal((await database.query("update drops set responsible='Negado' returning id")).rows.length, 0)
    await assert.rejects(database.exec('delete from drops'), { code: '42501' })
    await database.exec('reset role')
    assert.deepEqual((await database.query('select name,responsible from drops order by id')).rows, [
      { name: '', responsible: 'Gerente autorizado' },
      { name: '', responsible: 'Gerente autorizado' },
    ])
  })
})