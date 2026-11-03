import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const successorsMigration = await readFile(new URL('../supabase/migrations/20261014130000_registration_operation_successors.sql', import.meta.url), 'utf8')
const optionalNameMigration = await readFile(new URL('../supabase/migrations/20261023140000_optional_drop_name.sql', import.meta.url), 'utf8')
const migration = await readFile(new URL('../supabase/migrations/20261103120000_allow_operation_interval_reduction.sql', import.meta.url), 'utf8')

async function withDatabase(run, { applyMigration = true, seed } = {}) {
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
      create table public.financial_history (id integer primary key, amount numeric, notes text);
      alter table public.financial_drop_items enable row level security;
      alter table public.financial_history enable row level security;
      create policy finance_read on public.financial_drop_items for select to authenticated using (true);
      create policy history_read on public.financial_history for select to authenticated using (true);
      grant select on public.financial_drop_items,public.financial_history to authenticated;
      insert into public.financial_drop_items values (1,123.45,'{"name":"Original","responsible":"Historico","operationEndedAt":null}');
      insert into public.financial_history values (1,123.45,'Fechamento original preservado');
      insert into drops(name,partner,municipality,responsible) values
        ('Ponto legado','IMILE','Suzano','Aberto'),
        (' ponto  legado ',' imile ','SUZANO','Duplicado aberto');
      insert into drops(name,partner,municipality,responsible,operation_started_at,operation_ended_at,is_active) values
        ('Ponto datado','IMILE','Suzano','Datado','2026-10-01','2026-10-31',true),
        ('Ponto datado','IMILE','Suzano','Duplicado datado','2026-10-01','2026-10-31',true),
        ('Ponto inativo','IMILE','Suzano','Inativo','2026-10-01','2026-10-31',false),
        ('Ponto inativo','IMILE','Suzano','Duplicado inativo','2026-10-01','2026-10-31',true);
    `)
    if (seed) await seed(database)
    await database.exec(successorsMigration)
    await database.exec(optionalNameMigration)
    if (applyMigration) await database.exec(migration)
    await run(database)
  } finally {
    await database.close()
  }
}

async function snapshot(database) {
  return {
    drops: (await database.query('select * from public.drops order by id')).rows,
    financial: (await database.query('select * from public.financial_drop_items order by id')).rows,
    history: (await database.query('select * from public.financial_history order by id')).rows,
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

async function guardDefinition(database) {
  return (await database.query("select pg_get_functiondef('public.guard_drop_duplicate()'::regprocedure) as definition")).rows[0].definition.replaceAll('\r\n', '\n')
}

test('regression: legacy overlaps block end-only and two-bound reductions until the migration', async () => {
  await withDatabase(async database => {
    const endOnly = "update drops set operation_ended_at='2026-10-10' where responsible='Aberto'"
    const bothBounds = "update drops set operation_started_at='2026-10-05',operation_ended_at='2026-10-10' where responsible='Datado'"
    await assert.rejects(database.exec(endOnly), { code: '23505' })
    await assert.rejects(database.exec(bothBounds), { code: '23505' })
    await database.exec(migration)
    await database.exec(endOnly)
    await database.exec(bothBounds)
    assert.deepEqual((await database.query("select responsible,operation_started_at::text as start,operation_ended_at::text as end from drops where responsible in ('Aberto','Datado') order by responsible")).rows, [
      { responsible: 'Aberto', start: null, end: '2026-10-10' },
      { responsible: 'Datado', start: '2026-10-05', end: '2026-10-10' },
    ])
    assert.equal((await database.query('select count(*) from drops')).rows[0].count, 6)
  }, { applyMigration: false })
})

test('migration is repeatable and preserves rows, history, policies, locks and guard metadata', async () => {
  await withDatabase(async database => {
    const before = await snapshot(database)
    const previousGuard = await guardDefinition(database)
    await database.exec(migration)
    const changedGuard = await guardDefinition(database)
    for (let repeat = 0; repeat < 3; repeat++) {
      assert.deepEqual(await snapshot(database), before)
      await database.exec(migration)
      assert.equal(await guardDefinition(database), changedGuard)
    }
    const dateCheck = "  if new.operation_started_at > new.operation_ended_at then raise exception 'Fim da operacao anterior ao inicio.' using errcode='23514'; end if;\n"
    const lock = '  perform pg_advisory_xact_lock(hashtextextended(identity,1));\n'
    const reductionStart = changedGuard.indexOf("  if tg_op='UPDATE'", changedGuard.indexOf(lock))
    const overlapStart = changedGuard.indexOf('  if exists(select 1 from public.drops other')
    assert.ok(reductionStart > changedGuard.indexOf(lock))
    assert.ok(overlapStart > reductionStart)
    const withoutReduction = changedGuard.slice(0, reductionStart) + changedGuard.slice(overlapStart)
    assert.equal(withoutReduction.replace(dateCheck, ''), previousGuard.replace(dateCheck, ''))
    assert.ok(changedGuard.indexOf(dateCheck) < changedGuard.indexOf('if not new.is_active'))
    await database.exec("update drops set operation_ended_at='2026-10-10' where responsible='Aberto'")
    const afterReduction = await snapshot(database)
    assert.deepEqual(afterReduction.financial, before.financial)
    assert.deepEqual(afterReduction.history, before.history)
    assert.deepEqual(afterReduction.drops.filter(row => row.responsible !== 'Aberto'), before.drops.filter(row => row.responsible !== 'Aberto'))
    await database.exec(migration)
    assert.deepEqual(await snapshot(database), afterReduction)
  }, { applyMigration: false })
})

test('strict contained reductions accept start-only, normalized identity, inactive and one-day intervals', async () => {
  await withDatabase(async database => {
    const accentedName = 'P' + String.fromCharCode(0x00f3) + 'nto  legado'
    await database.query("update drops set name=$1,partner=' imile ',municipality='SUZANO',registration_type='drop_off',operation_started_at='2026-10-01' where responsible='Aberto'", [accentedName])
    await database.exec(`
      update drops set operation_started_at='2026-10-05' where responsible='Datado';
      update drops set operation_ended_at='2026-10-10' where responsible='Datado';
      update drops set operation_started_at='2026-10-10' where responsible='Datado';
      update drops set operation_started_at='2026-10-10',operation_ended_at='2026-10-10' where responsible='Inativo';
      update drops set responsible=responsible where name='Ponto datado';
      update drops set name=upper(name) where responsible='Datado';
    `)
    assert.equal((await database.query("select count(*) from drops where operation_started_at=operation_ended_at")).rows[0].count, 2)
    assert.equal((await database.query("select is_active from drops where responsible='Inativo'")).rows[0].is_active, false)
  })
})

test('expansion, clearing bounds and moving to new days still reject overlapping duplicates', async () => {
  await withDatabase(async database => {
    await database.exec("update drops set operation_started_at='2026-10-10',operation_ended_at='2026-10-20' where responsible='Datado'")
    const before = await snapshot(database)
    for (const change of [
      "operation_started_at='2026-10-09'",
      "operation_ended_at='2026-10-21'",
      'operation_started_at=null',
      'operation_ended_at=null',
      'operation_started_at=null,operation_ended_at=null',
      "operation_started_at='2026-10-09',operation_ended_at='2026-10-10'",
      "operation_started_at='2026-10-20',operation_ended_at='2026-10-21'",
    ]) await assert.rejects(database.exec(`update drops set ${change} where responsible='Datado'`), { code: '23505' })
    assert.deepEqual(await snapshot(database), before)
  })
})

test('reduction cannot bypass changed name, partner, city, kind, activation or deactivation', async () => {
  await withDatabase(async database => {
    for (const [responsible, change] of [
      ['Nome diferente', "name='Ponto legado'"],
      ['Parceiro diferente', "partner='IMILE'"],
      ['Cidade diferente', "municipality='Suzano'"],
      ['Tipo diferente', "registration_type='drop_off'"],
      ['Ativar', 'is_active=true'],
      ['Aberto', 'is_active=false'],
    ]) {
      await assert.rejects(database.query(`update drops set ${change},operation_started_at='2026-10-05',operation_ended_at='2026-10-10' where responsible=$1`, [responsible]), { code: '23505' })
    }
    await database.exec("insert into drops(name,partner,municipality) values ('Identidade nova','IMILE','Suzano')")
    await database.exec("update drops set operation_ended_at='2026-10-10' where name='Identidade nova'")
  }, { seed: database => database.exec(`
    insert into drops(name,partner,municipality,responsible,registration_type,is_active) values
      ('Outro nome','IMILE','Suzano','Nome diferente',null,true),
      ('Ponto legado','OUTRO','Suzano','Parceiro diferente',null,true),
      ('Ponto legado','IMILE','Outra','Cidade diferente',null,true),
      ('Ponto legado','IMILE','Suzano','Tipo diferente','last_mile',true),
      ('Ponto legado','IMILE','Suzano','Ativar',null,false);
  `) })
})

test('identity fields cannot masquerade as unchanged through a concatenation delimiter collision', async () => {
  await withDatabase(async database => {
    await assert.rejects(database.exec("update drops set name='A',partner='B|C',operation_ended_at='2026-10-10' where responsible='Colisao origem'"), { code: '23505' })
  }, { seed: database => database.exec(`
    insert into drops(name,partner,municipality,responsible) values
      ('A|B','C','Suzano','Colisao origem'),('A','B|C','Suzano','Colisao destino');
  `) })
})

test('new duplicates are still rejected, with inclusive boundaries, adjacency and null endpoints', async () => {
  await withDatabase(async database => {
    for (const [name, start, end, active] of [
      ['Ponto legado', null, null, true],
      ['Ponto legado', '2026-10-01', '2026-10-10', true],
      ['Ponto legado', '2026-10-01', '2026-10-10', false],
      ['Ponto datado', null, '2026-10-01', true],
      ['Ponto datado', '2026-10-31', null, true],
      ['Ponto datado', '2026-10-31', '2026-11-01', false],
      ['Ponto inativo', '2026-10-10', '2026-10-10', true],
    ]) await assert.rejects(database.query(`insert into drops(name,partner,municipality,operation_started_at,operation_ended_at,is_active)
      values ($1,'IMILE','Suzano',$2,$3,$4)`, [name, start, end, active]), { code: '23505' })
    await database.exec(`
      insert into drops(name,partner,municipality,operation_ended_at,is_active)
        values ('Ponto datado','IMILE','Suzano','2026-09-30',false);
      insert into drops(name,partner,municipality,operation_started_at)
        values ('Ponto datado','IMILE','Suzano','2026-11-01');
      insert into drops(name,partner,municipality,is_active) values ('Ponto legado','IMILE','Suzano',false);
      insert into drops(name,partner,municipality) values
        ('Ponto legado','OUTRO','Suzano'),('Ponto legado','IMILE','Outra');
      insert into drops(name,partner,municipality,registration_type) values ('Ponto legado','IMILE','Suzano','last_mile');
    `)
    await assert.rejects(database.exec("update drops set operation_started_at='2026-10-31' where name='Ponto datado' and operation_started_at='2026-11-01'"), { code: '23505' })
    await database.exec("update drops set operation_ended_at='2026-11-10' where name='Ponto datado' and operation_started_at='2026-11-01'")
  })
})

test('a point created after migration still rejects real duplicates and accepts adjacent successors', async () => {
  await withDatabase(async database => {
    await database.exec(`
      insert into drops(name,partner,municipality,responsible,operation_started_at,operation_ended_at,is_active)
        values ('Ponto novo','IMILE','Suzano','Antecessor novo','2026-10-01','2026-10-10',false);
      insert into drops(name,partner,municipality,responsible,operation_started_at)
        values (' ponto  novo ',' imile ','SUZANO','Sucessor novo','2026-10-11');
    `)
    for (const [start, end] of [
      [null, null], [null, '2026-10-01'], ['2026-10-10', '2026-10-10'],
      ['2026-10-11', '2026-10-11'], ['2026-11-01', null],
    ]) await assert.rejects(database.query(`insert into drops(name,partner,municipality,operation_started_at,operation_ended_at)
      values ('PONTO NOVO','IMILE','Suzano',$1,$2)`, [start, end]), { code: '23505' })
    await assert.rejects(database.exec("update drops set operation_ended_at='2026-10-11' where responsible='Antecessor novo'"), { code: '23505' })
    await assert.rejects(database.exec("update drops set operation_started_at='2026-10-10' where responsible='Sucessor novo'"), { code: '23505' })
    await database.exec("update drops set operation_ended_at='2026-10-31' where responsible='Sucessor novo'")
    await database.exec("insert into drops(name,partner,municipality,operation_started_at) values ('Ponto novo','IMILE','Suzano','2026-11-01')")
    assert.equal((await database.query("select count(*) from drops where public.registration_identity(name)='PONTO NOVO'")).rows[0].count, 3)
  })
})

test('inverted dates are rejected before reduction and blank-name bypasses, including invalid legacy rows', async () => {
  await withDatabase(async database => {
    for (const name of ['', '   ', 'Novo ponto']) {
      for (const isActive of [true, false]) {
        await assert.rejects(database.query(`insert into drops(name,partner,municipality,is_active,operation_started_at,operation_ended_at)
          values ($1,'IMILE','Suzano',$2,'2026-10-31','2026-10-01')`, [name, isActive]), { code: '23514' })
      }
    }
    for (const responsible of ['Aberto', 'Datado', 'Inativo']) {
      await assert.rejects(database.query("update drops set operation_started_at='2026-10-20',operation_ended_at='2026-10-10' where responsible=$1", [responsible]), { code: '23514' })
    }
    await database.exec('alter table drops drop constraint drops_operation_dates_check')
    await assert.rejects(database.exec("update drops set name=upper(name) where responsible='Invalido legado'"), { code: '23514' })
    await assert.rejects(database.exec("update drops set operation_started_at='2026-10-20',operation_ended_at='2026-10-10' where responsible='Datado'"), { code: '23514' })
    await assert.rejects(database.exec("insert into drops(name,partner,municipality,operation_started_at,operation_ended_at) values ('','IMILE','Suzano','2026-10-31','2026-10-01')"), { code: '23514' })
  }, { seed: database => database.exec(`
    insert into drops(name,partner,municipality,responsible,operation_started_at,operation_ended_at)
      values ('Invalido','IMILE','Suzano','Invalido legado','2026-10-31','2026-10-01');
  `) })
})

test('blank-name behavior and not-null protections are preserved', async () => {
  await withDatabase(async database => {
    await database.exec(`
      insert into drops(name,partner,municipality) values ('','IMILE','Suzano'),('   ','IMILE','Suzano');
      update drops set operation_started_at='2026-10-01',operation_ended_at='2026-10-10' where trim(name)='';
      update drops set name='',partner='OUTRO',municipality='Outra',registration_type='last_mile',is_active=false where trim(name)='';
      update drops set operation_started_at=null,operation_ended_at=null,is_active=true where name='';
    `)
    assert.equal((await database.query("select count(*) from drops where name='' and is_active and operation_started_at is null and operation_ended_at is null")).rows[0].count, 2)
    for (const change of ['name=null', 'partner=null', 'municipality=null', 'is_active=null']) {
      await assert.rejects(database.exec(`update drops set ${change} where name=''`), { code: '23502' })
    }
  })
})

test('interval reduction preserves manager, viewer, anonymous and restrictive RLS protections', async () => {
  await withDatabase(async database => {
    const before = await snapshot(database)
    await database.exec('set role anon')
    await assert.rejects(database.exec("update drops set operation_ended_at='2026-10-10' where responsible='Aberto'"), { code: '42501' })
    await assert.rejects(database.exec("insert into drops(name,partner,municipality) values ('Novo','IMILE','Suzano')"), { code: '42501' })
    await database.exec("reset role; set role authenticated; select set_config('test.can_manage','no',false)")
    assert.equal((await database.query("update drops set operation_ended_at='2026-10-10' where responsible='Aberto' returning id")).rows.length, 0)
    await assert.rejects(database.exec("insert into drops(name,partner,municipality) values ('Novo','IMILE','Suzano')"), { code: '42501' })
    await database.exec("select set_config('test.can_manage','yes',false); select set_config('test.blocked','yes',false)")
    assert.equal((await database.query("update drops set operation_ended_at='2026-10-10' where responsible='Aberto' returning id")).rows.length, 0)
    await assert.rejects(database.exec("insert into drops(name,partner,municipality) values ('Novo','IMILE','Suzano')"), { code: '42501' })
    await database.exec("select set_config('test.blocked','no',false)")
    assert.equal((await database.query("update drops set operation_ended_at='2026-10-10' where responsible='Aberto' returning id")).rows.length, 1)
    await assert.rejects(database.exec("insert into drops(name,partner,municipality) values ('Ponto legado','IMILE','Suzano')"), { code: '23505' })
    await assert.rejects(database.exec('delete from drops'), { code: '42501' })
    await assert.rejects(database.exec('update financial_history set amount=0'), { code: '42501' })
    await database.exec('reset role')
    const after = await snapshot(database)
    assert.deepEqual(after.financial, before.financial)
    assert.deepEqual(after.history, before.history)
    assert.deepEqual(after.policies, before.policies)
    assert.deepEqual(after.grants, before.grants)
  })
})

test('missing guard, normalization helper, date columns or active trigger abort without partial changes', async () => {
  for (const removePrerequisite of [
    'drop function public.guard_drop_duplicate() cascade',
    'drop function public.registration_identity(text)',
    'alter table drops drop column operation_started_at cascade',
    'alter table drops drop column operation_ended_at cascade',
    'drop trigger guard_drop_duplicate on drops',
    'alter table drops disable trigger guard_drop_duplicate',
  ]) {
    await withDatabase(async database => {
      await database.exec(removePrerequisite)
      const before = (await database.query('select to_jsonb(drops) as row from drops order by id')).rows
      await assert.rejects(database.exec(migration), /Prerequisito ausente/)
      await database.exec('rollback')
      assert.deepEqual((await database.query('select to_jsonb(drops) as row from drops order by id')).rows, before)
      if (removePrerequisite.startsWith('drop function public.guard')) {
        assert.equal((await database.query("select to_regprocedure('public.guard_drop_duplicate()') as guard")).rows[0].guard, null)
      } else {
        assert.ok(!(await guardDefinition(database)).includes("coalesce(old.operation_started_at,'-infinity'::date)"))
      }
    }, { applyMigration: false })
  }
})