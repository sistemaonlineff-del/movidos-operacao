import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const successorsMigration = await readFile(new URL('../supabase/migrations/20261014130000_registration_operation_successors.sql', import.meta.url), 'utf8')
const optionalNameMigration = await readFile(new URL('../supabase/migrations/20261023140000_optional_drop_name.sql', import.meta.url), 'utf8')
const reductionMigration = await readFile(new URL('../supabase/migrations/20261103120000_allow_operation_interval_reduction.sql', import.meta.url), 'utf8')
const softDeleteMigration = await readFile(new URL('../supabase/migrations/20260911170000_email_and_soft_delete.sql', import.meta.url), 'utf8')
const migration = await readFile(new URL('../supabase/migrations/20261105120000_allow_legacy_operation_deactivation.sql', import.meta.url), 'utf8')
const deleteProtection = softDeleteMigration.slice(
  softDeleteMigration.indexOf('create or replace function public.prevent_business_record_delete()'),
  softDeleteMigration.indexOf('drop trigger if exists prevent_drop_documents_delete'),
)
const actor = '11111111-1111-4111-8111-111111111111'

async function withDatabase(run, { applyMigration = true } = {}) {
  const database = new PGlite()
  try {
    await database.exec(`
      create role authenticated;
      create role anon;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('test.actor',true),'')::uuid;
      $$;
      grant usage on schema auth to authenticated;
      create table public.drops (
        id uuid primary key default gen_random_uuid(),
        name text not null,
        partner text not null,
        municipality text not null,
        registration_type text,
        is_active boolean not null default true,
        responsible text,
        operation_started_at date,
        operation_ended_at date,
        deactivated_reason text,
        deactivated_at timestamptz,
        deactivated_by uuid
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
      create table public.financial_drop_items (id integer primary key, drop_id uuid references public.drops(id), amount numeric, registration_snapshot jsonb);
      create table public.financial_payment_history (id integer primary key, drop_id uuid references public.drops(id), amount numeric, notes text);
      alter table public.financial_drop_items enable row level security;
      alter table public.financial_payment_history enable row level security;
      create policy finance_read on public.financial_drop_items for select to authenticated using (true);
      create policy history_read on public.financial_payment_history for select to authenticated using (true);
      grant select on public.financial_drop_items,public.financial_payment_history to authenticated;
      create table public.fixture_audit_logs (id bigint generated always as identity primary key, actor uuid, before_row jsonb, after_row jsonb);
      alter table public.fixture_audit_logs enable row level security;
      insert into drops(name,partner,municipality,responsible,operation_started_at,operation_ended_at,is_active) values
        ('Ponto aberto','IMILE','Suzano','Aberto',null,null,true),
        (' ponto  aberto ',' imile ','SUZANO','Duplicado aberto',null,null,true),
        ('Ponto datado','IMILE','Suzano','Datado','2026-10-01','2026-10-31',true),
        ('Ponto datado','IMILE','Suzano','Duplicado datado','2026-10-01','2026-10-31',true),
        ('Ponto inativo','IMILE','Suzano','Inativo','2026-10-01','2026-10-31',false),
        ('Ponto inativo','IMILE','Suzano','Duplicado inativo','2026-10-01','2026-10-31',false),
        ('Outro nome','IMILE','Suzano','Nome diferente',null,null,true),
        ('Ponto aberto','OUTRO','Suzano','Parceiro diferente',null,null,true),
        ('Ponto aberto','IMILE','Outra','Cidade diferente',null,null,true),
        ('Ponto aberto','IMILE','Suzano','Tipo diferente',null,null,true),
        ('A|B','C','Suzano','Colisao origem',null,null,true),
        ('A','B|C','Suzano','Colisao destino',null,null,true),
        ('Invalido','IMILE','Suzano','Invalido legado','2026-10-31','2026-10-01',true);
      update drops set registration_type='last_mile' where responsible='Tipo diferente';
      insert into public.financial_drop_items
        select 1,id,123.45,'{"name":"Ponto datado","responsible":"Historico","operationEndedAt":null}' from drops where responsible='Datado';
      insert into public.financial_payment_history
        select 1,id,123.45,'Fechamento original preservado' from drops where responsible='Datado';
      create function public.fixture_require_deactivation_reason() returns trigger language plpgsql as $$
      begin
        if old.is_active and not new.is_active then
          if trim(coalesce(new.deactivated_reason,''))='' then
            raise exception 'Informe o motivo da desativacao.' using errcode='23514';
          end if;
          new.deactivated_at:=now();
          new.deactivated_by:=auth.uid();
        end if;
        return new;
      end;
      $$;
      create trigger fixture_require_deactivation_reason before update on public.drops
        for each row execute function public.fixture_require_deactivation_reason();
      create function public.fixture_audit_drop_change() returns trigger
        language plpgsql security definer set search_path=public,pg_temp as $$
      begin
        insert into public.fixture_audit_logs(actor,before_row,after_row) values (auth.uid(),to_jsonb(old),to_jsonb(new));
        return new;
      end;
      $$;
      create trigger fixture_audit_drop_change after update on public.drops
        for each row execute function public.fixture_audit_drop_change();
      select set_config('test.actor','${actor}',false);
    `)
    assert.ok(deleteProtection.includes('create trigger prevent_drops_delete'))
    await database.exec(deleteProtection)
    await database.exec(successorsMigration)
    await database.exec(optionalNameMigration)
    await database.exec(reductionMigration)
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
    history: (await database.query('select * from public.financial_payment_history order by id')).rows,
    audit: (await database.query('select * from public.fixture_audit_logs order by id')).rows,
    policies: (await database.query('select * from pg_policies order by schemaname,tablename,policyname')).rows,
    grants: (await database.query("select * from information_schema.table_privileges where table_schema='public' order by table_name,grantee,privilege_type")).rows,
    columns: (await database.query("select table_name,column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema='public' order by table_name,ordinal_position")).rows,
    constraints: (await database.query("select conname,convalidated,pg_get_constraintdef(oid) as definition from pg_constraint where connamespace='public'::regnamespace order by conname")).rows,
    security: (await database.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r' order by relname")).rows,
    triggers: (await database.query("select oid,pg_get_triggerdef(oid) as definition from pg_trigger where tgrelid='public.drops'::regclass and not tgisinternal order by tgname")).rows,
    functions: (await database.query("select oid,proname,proowner,proacl,prosecdef,proconfig from pg_proc where pronamespace='public'::regnamespace order by proname")).rows,
    otherFunctionBodies: (await database.query("select pg_get_functiondef(oid) as definition from pg_proc where pronamespace='public'::regnamespace and proname<>'guard_drop_duplicate' order by proname")).rows,
  }
}

async function guardDefinition(database) {
  return (await database.query("select pg_get_functiondef('public.guard_drop_duplicate()'::regprocedure) as definition")).rows[0].definition.replaceAll('\r\n', '\n')
}

async function deactivate(database, responsible, change = '') {
  return database.query(`update public.drops set is_active=false,deactivated_reason='Encerramento solicitado'${change ? ',' + change : ''}
    where responsible=$1 returning *`, [responsible])
}

test('regression: legacy overlaps block equal and reduced deactivation before migration, then allow both', async () => {
  await withDatabase(async database => {
    const before = await snapshot(database)
    await assert.rejects(deactivate(database, 'Datado'), { code: '23505' })
    await assert.rejects(deactivate(database, 'Aberto', "operation_ended_at='2026-10-10'"), { code: '23505' })
    assert.deepEqual(await snapshot(database), before)
    await database.exec(migration)
    assert.equal((await deactivate(database, 'Datado')).rows[0].is_active, false)
    assert.equal((await deactivate(database, 'Aberto', "operation_ended_at='2026-10-10'")).rows[0].is_active, false)
    const after = await snapshot(database)
    assert.equal(after.drops.length, before.drops.length)
    assert.deepEqual(after.financial, before.financial)
    assert.deepEqual(after.history, before.history)
    assert.deepEqual(after.drops.filter(row => !['Datado', 'Aberto'].includes(row.responsible)), before.drops.filter(row => !['Datado', 'Aberto'].includes(row.responsible)))
    assert.equal(after.audit.length, 2)
  }, { applyMigration: false })
})

test('migration is repeatable and preserves rows, RLS, triggers, history, guard metadata and prior reduction code', async () => {
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
    const lock = '  perform pg_advisory_xact_lock(hashtextextended(identity,1));\n'
    const exceptionStart = changedGuard.indexOf("  if tg_op='UPDATE'", changedGuard.indexOf(lock))
    const previousReductionStart = changedGuard.indexOf("  if tg_op='UPDATE'", exceptionStart + 1)
    assert.ok(exceptionStart > changedGuard.indexOf(lock))
    assert.ok(previousReductionStart > exceptionStart)
    const withoutDeactivation = (changedGuard.slice(0, exceptionStart) + changedGuard.slice(previousReductionStart))
      .replace("  if not new.is_active and new.operation_started_at is null and new.operation_ended_at is null\n    and (tg_op<>'UPDATE' or old.is_active is not true) then return new; end if;",
        '  if not new.is_active and new.operation_started_at is null and new.operation_ended_at is null then return new; end if;')
    assert.equal(withoutDeactivation, previousGuard)
    assert.ok(changedGuard.indexOf('if new.operation_started_at > new.operation_ended_at') < changedGuard.indexOf('if not new.is_active'))
    await deactivate(database, 'Datado')
    const after = await snapshot(database)
    await database.exec(migration)
    assert.deepEqual(await snapshot(database), after)
  }, { applyMigration: false })
})

test('deactivation accepts normalized identity per field, equal/open intervals and every contained reduction shape', async () => {
  const accentedName = 'P' + String.fromCharCode(0x00f3) + 'nto  datado'
  for (const [responsible, change] of [
    ['Aberto', ''],
    ['Aberto', "operation_started_at='2026-10-05'"],
    ['Aberto', "operation_ended_at='2026-10-10'"],
    ['Aberto', "operation_started_at='2026-10-05',operation_ended_at='2026-10-10'"],
    ['Datado', ''],
    ['Datado', "operation_started_at='2026-10-05'"],
    ['Datado', "operation_ended_at='2026-10-10'"],
    ['Datado', "operation_started_at='2026-10-10',operation_ended_at='2026-10-10'"],
  ]) {
    await withDatabase(async database => {
      if (responsible === 'Datado') {
        await database.query("update drops set name=$1,partner=' imile ',municipality='SUZANO',registration_type='drop_off' where responsible=$2", [accentedName, responsible])
      }
      const before = await snapshot(database)
      const result = (await deactivate(database, responsible, change)).rows
      assert.equal(result.length, 1)
      assert.equal(result[0].is_active, false)
      assert.equal(result[0].deactivated_reason, 'Encerramento solicitado')
      assert.equal(result[0].deactivated_by, actor)
      assert.ok(result[0].deactivated_at)
      const after = await snapshot(database)
      assert.deepEqual(after.financial, before.financial)
      assert.deepEqual(after.history, before.history)
      assert.deepEqual(after.drops.filter(row => row.responsible !== responsible), before.drops.filter(row => row.responsible !== responsible))
      assert.equal(after.audit.length, before.audit.length + 1)
      assert.equal(after.audit.at(-1).before_row.is_active, true)
      assert.equal(after.audit.at(-1).after_row.is_active, false)
    })
  }
})

test('deactivation cannot expand, clear finite endpoints or trade earlier days for later days', async () => {
  await withDatabase(async database => {
    await database.exec("update drops set operation_started_at='2026-10-10',operation_ended_at='2026-10-20' where responsible='Datado'")
    const before = await snapshot(database)
    for (const change of [
      "operation_started_at='2026-10-09'", "operation_ended_at='2026-10-21'",
      'operation_started_at=null', 'operation_ended_at=null',
      'operation_started_at=null,operation_ended_at=null',
      "operation_started_at='2026-10-09',operation_ended_at='2026-10-10'",
      "operation_started_at='2026-10-20',operation_ended_at='2026-10-21'",
    ]) await assert.rejects(deactivate(database, 'Datado', change), { code: '23505' })
    assert.deepEqual(await snapshot(database), before)
  })
})

test('changed name, partner, city and kind cannot use deactivation to bypass legacy overlaps', async () => {
  await withDatabase(async database => {
    const before = await snapshot(database)
    for (const [responsible, change] of [
      ['Nome diferente', "name='Ponto aberto'"],
      ['Parceiro diferente', "partner='IMILE'"],
      ['Cidade diferente', "municipality='Suzano'"],
      ['Tipo diferente', "registration_type='drop_off'"],
      ['Colisao origem', "name='A',partner='B|C'"],
    ]) {
      await assert.rejects(deactivate(database, responsible, change), { code: '23505' })
      await assert.rejects(deactivate(database, responsible, `${change},operation_ended_at='2026-10-10'`), { code: '23505' })
    }
    assert.deepEqual(await snapshot(database), before)
  })
})

test('activation never receives the exception, including equal intervals and strict reductions', async () => {
  await withDatabase(async database => {
    const before = await snapshot(database)
    for (const change of ['', ",operation_started_at='2026-10-05',operation_ended_at='2026-10-10'", ',operation_started_at=null,operation_ended_at=null']) {
      await assert.rejects(database.exec(`update drops set is_active=true${change} where responsible='Inativo'`), { code: '23505' })
    }
    assert.deepEqual(await snapshot(database), before)
    await deactivate(database, 'Datado')
    await assert.rejects(database.exec("update drops set is_active=true,operation_ended_at='2026-10-10' where responsible='Datado'"), { code: '23505' })
  })
})

test('prior active and inactive reductions still work without allowing expansions', async () => {
  await withDatabase(async database => {
    for (const responsible of ['Datado', 'Inativo']) {
      await database.query("update drops set operation_started_at='2026-10-10',operation_ended_at='2026-10-20' where responsible=$1", [responsible])
      for (const change of ["operation_started_at='2026-10-09'", "operation_ended_at='2026-10-21'"]) {
        await assert.rejects(database.query(`update drops set ${change} where responsible=$1`, [responsible]), { code: '23505' })
      }
    }
    assert.equal((await database.query("select is_active from drops where responsible='Inativo'")).rows[0].is_active, false)
    await database.exec("update drops set responsible=responsible,name=upper(name) where responsible='Datado'")
  })
})

test('new duplicates remain blocked against active and deactivated histories, with inclusive boundaries', async () => {
  await withDatabase(async database => {
    await deactivate(database, 'Inativo')
    await deactivate(database, 'Datado')
    await deactivate(database, 'Duplicado datado')
    for (const [name, start, end, active] of [
      ['Ponto aberto', null, null, true],
      ['Ponto aberto', '2026-10-01', '2026-10-10', false],
      ['Ponto datado', null, '2026-10-01', true],
      ['Ponto datado', '2026-10-31', null, false],
      ['Ponto datado', '2026-10-10', '2026-10-10', true],
      ['Ponto inativo', '2026-10-10', '2026-10-10', true],
    ]) await assert.rejects(database.query(`insert into drops(name,partner,municipality,operation_started_at,operation_ended_at,is_active)
      values ($1,'IMILE','Suzano',$2,$3,$4)`, [name, start, end, active]), { code: '23505' })
    await database.exec(`
      insert into drops(name,partner,municipality,operation_ended_at,is_active) values ('Ponto datado','IMILE','Suzano','2026-09-30',false);
      insert into drops(name,partner,municipality,operation_started_at) values ('Ponto datado','IMILE','Suzano','2026-11-01');
      insert into drops(name,partner,municipality,is_active) values ('Ponto aberto','IMILE','Suzano',false);
    `)
    await assert.rejects(database.exec("update drops set operation_started_at='2026-10-31' where name='Ponto datado' and operation_started_at='2026-11-01'"), { code: '23505' })
  })
})

test('inverted dates are rejected before all shortcuts, even without the table constraint', async () => {
  await withDatabase(async database => {
    await database.exec('alter table drops drop constraint drops_operation_dates_check')
    const before = await snapshot(database)
    for (const responsible of ['Datado', 'Aberto', 'Inativo', 'Invalido legado']) {
      await assert.rejects(deactivate(database, responsible, "operation_started_at='2026-10-20',operation_ended_at='2026-10-10'"), { code: '23514' })
    }
    await assert.rejects(deactivate(database, 'Invalido legado'), { code: '23514' })
    for (const name of ['', '   ', 'Novo ponto']) {
      for (const active of [true, false]) {
        await assert.rejects(database.query(`insert into drops(name,partner,municipality,is_active,operation_started_at,operation_ended_at)
          values ($1,'IMILE','Suzano',$2,'2026-10-31','2026-10-01')`, [name, active]), { code: '23514' })
      }
    }
    assert.deepEqual(await snapshot(database), before)
  })
})

test('fixture reason and audit triggers remain effective, with atomic rollback and no physical deletion', async () => {
  await withDatabase(async database => {
    const before = await snapshot(database)
    for (const reason of [null, '', '   ']) {
      await assert.rejects(database.query("update drops set is_active=false,deactivated_reason=$1 where responsible='Datado'", [reason]), { code: '23514', message: 'Informe o motivo da desativacao.' })
    }
    assert.deepEqual(await snapshot(database), before)
    await database.exec('begin')
    await deactivate(database, 'Datado')
    await database.exec('rollback')
    assert.deepEqual(await snapshot(database), before)
    await deactivate(database, 'Datado')
    const after = await snapshot(database)
    assert.equal(after.audit.length, 1)
    assert.equal(after.audit[0].actor, actor)
    assert.equal(after.audit[0].after_row.deactivated_reason, 'Encerramento solicitado')
    assert.equal(after.audit[0].after_row.deactivated_by, actor)
    assert.ok(after.audit[0].after_row.deactivated_at)
    assert.deepEqual(after.triggers, before.triggers)
    await assert.rejects(database.exec("delete from drops where responsible='Datado'"), /Exclus/)
    assert.deepEqual(await snapshot(database), after)
  })
})

test('RLS still denies anonymous, viewer and restricted managers while allowing an authorized manager', async () => {
  await withDatabase(async database => {
    const before = await snapshot(database)
    await database.exec('set role anon')
    await assert.rejects(deactivate(database, 'Datado'), { code: '42501' })
    await database.exec("reset role; set role authenticated; select set_config('test.can_manage','no',false)")
    assert.equal((await deactivate(database, 'Datado')).rows.length, 0)
    await assert.rejects(database.exec("insert into drops(name,partner,municipality) values ('Novo','IMILE','Suzano')"), { code: '42501' })
    await database.exec("select set_config('test.can_manage','yes',false); select set_config('test.blocked','yes',false)")
    assert.equal((await deactivate(database, 'Datado')).rows.length, 0)
    await assert.rejects(database.exec("insert into drops(name,partner,municipality) values ('Novo','IMILE','Suzano')"), { code: '42501' })
    await database.exec('reset role')
    assert.deepEqual(await snapshot(database), before)
    await database.exec("set role authenticated; select set_config('test.blocked','no',false)")
    assert.equal((await deactivate(database, 'Datado')).rows.length, 1)
    await assert.rejects(database.exec("update drops set is_active=true where responsible='Datado'"), { code: '23505' })
    await assert.rejects(database.exec('delete from drops'), { code: '42501' })
    await assert.rejects(database.exec('update financial_payment_history set amount=0'), { code: '42501' })
    await assert.rejects(database.exec('delete from fixture_audit_logs'), { code: '42501' })
    await database.exec('reset role')
    const after = await snapshot(database)
    assert.deepEqual(after.policies, before.policies)
    assert.deepEqual(after.grants, before.grants)
    assert.deepEqual(after.financial, before.financial)
    assert.deepEqual(after.history, before.history)
    assert.equal(after.audit.length, 1)
  })
})

test('missing guard, helper, date columns or enabled INSERT/UPDATE trigger abort without partial changes', async () => {
  for (const removePrerequisite of [
    'drop function public.guard_drop_duplicate() cascade',
    'drop function public.registration_identity(text)',
    'alter table drops drop column operation_started_at cascade',
    'alter table drops drop column operation_ended_at cascade',
    'drop trigger guard_drop_duplicate on drops',
    'alter table drops disable trigger guard_drop_duplicate',
    'drop trigger guard_drop_duplicate on drops; create trigger guard_drop_duplicate after insert or update on drops for each row execute function guard_drop_duplicate()',
    'drop trigger guard_drop_duplicate on drops; create trigger guard_drop_duplicate before update on drops for each row execute function guard_drop_duplicate()',
  ]) {
    await withDatabase(async database => {
      await database.exec(removePrerequisite)
      const before = await snapshot(database)
      await assert.rejects(database.exec(migration), /Prerequisito ausente/)
      await database.exec('rollback')
      assert.deepEqual(await snapshot(database), before)
    }, { applyMigration: false })
  }
})