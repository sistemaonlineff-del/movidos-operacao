import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const userId='11111111-1111-4111-8111-111111111111', id='22222222-2222-4222-8222-222222222222'
const snapshot={name:'Drop Teste',responsible:'Pessoa Teste',phone:'11999999999',address:'Rua Teste',address_number:'10',neighborhood:'Centro',municipality:'Suzano',state:'SP',postal_code:'08600000',pix_key:'teste@example.invalid',pix_holder_name:'Pessoa Teste',latitude:-23.5,longitude:-46.3}
const manifest=[{path:`submissions/${id}/33333333-3333-4333-8333-333333333333.png`,hash:'b'.repeat(64),size:70,type:'image/png',name:'foto.png',caption:''}]
const migration=await readFile('supabase/migrations/20261108140000_public_drop_registration.sql','utf8')
const literal=value=>`'${JSON.stringify(value).replaceAll("'","''")}'::jsonb`

test('isolated intake SQL: anon/storage deny, atomic quotas, retry, actual guards and approval never activates',async()=>{
  const db=new PGlite()
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;create table auth.users(id uuid primary key, email text,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,metadata jsonb,owner_id text);
      alter table storage.objects enable row level security;grant all on storage.objects to anon,authenticated,service_role;
      grant usage on schema auth,storage to anon,authenticated,service_role;
      create policy old_broad_policy on storage.objects for all to anon,authenticated using(true) with check(true);`)
    const schema=(await readFile('supabase/schema.sql','utf8')).replaceAll('create extension if not exists pgcrypto;','').replaceAll('create extension if not exists citext;','').replaceAll('citext','text')
    await db.exec(schema)
    await db.exec(await readFile('supabase/05_user_permissions.sql','utf8').then(text=>text.slice(0,text.indexOf('-- As permiss'))))
    await db.exec(`alter table drops add column registration_type text default 'drop_off' check(registration_type in ('drop_off','last_mile'));
      alter table drops add column operation_started_at date;alter table drops add column operation_ended_at date;`)
    await db.exec(await readFile('supabase/migrations/20261012110000_registration_route_guards.sql','utf8').then(text=>text.slice(0,text.indexOf('create or replace function public.route_identity'))))
    await db.exec(await readFile('supabase/migrations/20261105120000_allow_legacy_operation_deactivation.sql','utf8'))
    await db.exec(`insert into auth.users(id,email) values('${userId}','reviewer@example.invalid');update user_profiles set role='admin' where id='${userId}';
      insert into user_module_permissions(user_id) values('${userId}');
      select set_config('request.jwt.claim.sub','${userId}',false);`)
    await db.exec(migration);await db.exec(migration)
    const guard=(await db.query("select prosrc from pg_proc where oid='guard_drop_duplicate()'::regprocedure")).rows
    await db.exec('set role anon')
    for (const sql of ['select * from drop_registration_intake',`insert into drop_registration_intake(id) values('${id}')`,`select drop_registration_review('${id}',0,'approve',null,null,null,null,'${userId}')`]) await assert.rejects(db.exec(sql),/permission denied/)
    assert.equal((await db.query("select * from storage.objects where bucket_id='drop-registration-private'")).rows.length,0)
    await assert.rejects(db.exec("insert into storage.objects(bucket_id,name) values('drop-registration-private','forged')"),/row-level security/)
    await db.exec("insert into storage.objects(bucket_id,name) values('unrelated','preserved')")
    await db.exec('reset role;set role service_role')
    const reserve=`select drop_registration_reserve('${id}','${'a'.repeat(64)}',${literal(snapshot)},${literal(manifest)},'${'c'.repeat(64)}') as record`
    const first=(await db.query(reserve)).rows[0].record
    assert.equal(first.status,'uploading');assert.equal((await db.query(reserve)).rows[0].record.id,id)
    assert.equal(first.consent_version,'drop-registration-v1');assert.ok(first.consented_at)
    await assert.rejects(db.exec(reserve.replace('a'.repeat(64),'d'.repeat(64))),/outro conteudo/)
    await assert.rejects(db.exec(`select drop_registration_finalize('${id}','${'a'.repeat(64)}')`),/sem confirmacao/)
    await db.exec(`insert into storage.objects(bucket_id,name,metadata) values('drop-registration-private','${manifest[0].path}','{"size":70,"mimetype":"image/png"}')`)
    await db.exec(`select drop_registration_finalize('${id}','${'a'.repeat(64)}')`)
    await db.exec('reset role;set role authenticated')
    const approve=`select drop_registration_review('${id}',1,'approve',${literal(snapshot)},null,null,null,'${userId}') as result`
    assert.equal((await db.query('select * from drop_registration_intake')).rows.length,1)
    await assert.rejects(db.exec(approve),/permission denied/)
    await assert.rejects(db.exec(`update drop_registration_intake set status='rejected'`),/permission denied/)
    await assert.rejects(db.exec(`select drop_registration_reserve('${id}','${'a'.repeat(64)}',${literal(snapshot)},${literal(manifest)},'${'c'.repeat(64)}')`),/permission denied/)
    await db.exec('reset role;set role service_role')
    const result=(await db.query(approve)).rows[0].result
    assert.equal(result.status,'approved');assert.equal((await db.query(approve)).rows[0].result.dropId,result.dropId)
    await db.exec('reset role;set role authenticated')
    await assert.rejects(db.exec("insert into storage.objects(bucket_id,name) values('drop-registration-private','direct')"),/row-level security/)
    await db.exec('reset role')
    const drop=(await db.query('select * from drops')).rows[0]
    assert.equal(drop.status,'INTERESSADO');assert.equal(drop.is_active,true);assert.equal(drop.operation_started_at,null);assert.equal(drop.operation_ended_at,null);assert.equal(drop.monthly_value,null);assert.equal(drop.signed_at,null)
    assert.equal(drop.deactivated_at,null);assert.equal(drop.deactivated_by,null);assert.equal(drop.deactivated_reason,null);assert.equal(drop.created_by,userId)
    assert.equal((await db.query('select count(*) from drops')).rows[0].count,1)
    assert.equal((await db.query('select count(*) from drop_documents')).rows[0].count,0)
    assert.equal((await db.query('select count(*) from financial_periods')).rows[0].count,0)
    await db.exec(`update user_profiles set is_active=false where id='${userId}';set role authenticated`)
    assert.equal((await db.query('select * from drop_registration_intake')).rows.length,0)
    await db.exec('reset role;set role service_role')
    await assert.rejects(db.exec(approve),/Sem permissao/)
    await db.exec(`reset role;update user_profiles set is_active=true,role='operador' where id='${userId}';set role service_role`)
    await assert.rejects(db.exec(approve),/Sem permissao/)
    await db.exec(`reset role;set role authenticated`)
    assert.equal((await db.query('select * from drop_registration_intake')).rows.length,0)
    await db.exec(`reset role;update user_module_permissions set cadastros_create=true,cadastros_edit=true where user_id='${userId}';set role service_role`)
    assert.equal((await db.query(approve)).rows[0].result.dropId,result.dropId)
    await assert.rejects(db.exec(approve.replace(userId,'99999999-9999-4999-8999-999999999999')),/Sem permissao/)
    await db.exec('reset role')
    await db.exec(migration)
    assert.deepEqual((await db.query("select prosrc from pg_proc where oid='guard_drop_duplicate()'::regprocedure")).rows,guard)
    await assert.rejects(db.exec(`select drop_registration_validate(${literal({...snapshot,is_active:true})})`),/Campo nao permitido/)
    await assert.rejects(db.exec(`select drop_registration_validate(${literal({...snapshot,cpf:'11111111111'})})`),/documento/)
    await assert.rejects(db.exec(`select drop_registration_validate(${literal({...snapshot,cnpj:'12345678901234'})})`),/documento/)
    await assert.rejects(db.exec(`select drop_registration_validate(${literal({...snapshot,pix_key:'chave-invalida'})})`),/PIX invalida/)
    const optional=(await db.query(`select drop_registration_validate(${literal({...snapshot,pix_key:null,pix_holder_name:null,neighborhood:null,email:null,cpf:null,cnpj:null})}) as value`)).rows[0].value
    assert.equal(optional.pix_key,null);assert.equal(optional.neighborhood,null)
    for (const pix_key of ['52998224725','11222333000181','+55 (11) 99999-9999','12345678-1234-4234-8234-123456789012']) assert.equal((await db.query(`select drop_registration_validate(${literal({...snapshot,pix_key})}) as value`)).rows[0].value.pix_key,pix_key)
    assert.equal((await db.query(`select drop_registration_validate(${literal({...snapshot,cpf:'52998224725',cnpj:'11222333000181'})}) as value`)).rows[0].value.cpf,'52998224725')
    await db.exec('set role anon')
    assert.equal((await db.query("select * from storage.objects where bucket_id='drop-registration-private'")).rows.length,0)
    assert.equal((await db.query("select * from storage.objects where bucket_id='unrelated'")).rows.length,1)
    await db.exec('reset role')
    const secondId='55555555-5555-4555-8555-555555555555'
    await db.exec(`insert into drop_registration_intake(id,content_hash,snapshot,photos,status,revision) values('${secondId}','${'f'.repeat(64)}',${literal(snapshot)},${literal(manifest)},'pending',1)`)
    await db.exec('set role service_role')
    const secondApproval=`select drop_registration_review('${secondId}',1,'approve',${literal(snapshot)},null,'J&T EXPRESS LTDA',null,'${userId}') as result`
    await assert.rejects(db.exec(secondApproval),/duplicados/)
    const duplicates=(await db.query(`select drop_registration_duplicates(${literal(snapshot)},'${userId}') as value`)).rows[0].value
    assert.equal(duplicates.matches.length,1)
    const distinct={...snapshot,name:'Outro nome',address:'Outra rua',address_number:'11'}
    assert.equal((await db.query(`select drop_registration_duplicates(${literal(distinct)},'${userId}') as value`)).rows[0].value.matches.length,0)
    await db.exec('reset role')
    await db.exec(`update drops set updated_at=updated_at+interval '1 second'`)
    await db.exec('set role service_role')
    await assert.rejects(db.exec(secondApproval.replace(`,null,'${userId}')`,`, '${duplicates.acknowledgment}','${userId}')`)),/duplicados/)
    const fresh=(await db.query(`select drop_registration_duplicates(${literal(snapshot)},'${userId}') as value`)).rows[0].value
    await assert.rejects(db.exec(secondApproval.replace("',1,'approve'","',0,'approve'")),/mudou/)
    await db.query(`select drop_registration_review('${secondId}',1,'save',${literal(snapshot)},'Revisao sintetica',null,null,'${userId}')`)
    await assert.rejects(db.exec(secondApproval),/mudou/)
    const acknowledged=secondApproval.replace("',1,'approve'","',2,'approve'").replace(`,null,'${userId}')`,`, '${fresh.acknowledgment}','${userId}')`)
    const second=(await db.query(acknowledged)).rows[0].result
    assert.equal((await db.query(acknowledged)).rows[0].result.dropId,second.dropId)
    await db.exec('reset role')
    assert.equal((await db.query("select count(*) from drops where is_active=true and status='INTERESSADO'")).rows[0].count,2)
    assert.equal((await db.query('select count(*) from audit_logs')).rows[0].count,2)
    await db.exec(`update drop_registration_limits set attempts=20 where bucket='${'c'.repeat(64)}';set role service_role`)
    assert.equal((await db.query(reserve)).rows[0].record,null)
    await db.exec(`reset role;update drop_registration_limits set attempts=500 where bucket='global';set role service_role`)
    assert.equal((await db.query(reserve.replaceAll('c'.repeat(64),'e'.repeat(64)))).rows[0].record,null)
    await db.exec('reset role')
    await db.exec(await readFile('tests/drop-registration-rollback.sql','utf8'))
    await db.exec('set role authenticated')
    await assert.rejects(db.exec(approve),/permission denied/)
    await db.exec('reset role;set role service_role')
    await assert.rejects(db.exec(reserve),/permission denied/)
    await db.exec('reset role')
    assert.equal((await db.query('select count(*) from drops')).rows[0].count,2)
    assert.equal((await db.query('select count(*) from drop_registration_intake')).rows[0].count,2)
    await db.exec(migration)
  } finally {await db.close()}
})