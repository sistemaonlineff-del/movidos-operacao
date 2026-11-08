import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { emptyState, validateState } from '../src/financas/domain.ts';

const migration = readFileSync(new URL('../supabase/migrations/20261108120000_private_finances.sql', import.meta.url), 'utf8');
const workspace = 'f1082026-1108-4000-8000-000000000001';
const fabio = '11111111-1111-4111-8111-111111111111';
const talita = '22222222-2222-4222-8222-222222222222';
const admin = '33333333-3333-4333-8333-333333333333';
const setup = async db => {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table public.user_profiles(id uuid primary key,is_active boolean,role text);
    create table public.financial_history(id integer primary key,sentinel text);
    insert into public.financial_history values(9,'LEGACY UNTOUCHED');
    grant usage on schema public,auth to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;`);
  await db.query(`insert into auth.users values($1,'fabioaf9@gmail.com',now()),($2,'talitapreviatti@gmail.com',now()),($3,'admin@example.com',now())`, [fabio,talita,admin]);
  await db.query(`insert into user_profiles values($1,true,'USER'),($2,true,'USER'),($3,true,'ADMIN')`, [fabio,talita,admin]);
};
const asUser = async (db,id,role='authenticated') => {
  await db.exec(`reset role; set role ${role}`);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id ?? '']);
};
const save = (db,revision,payload=emptyState(),target=workspace) => db.query('select financas_save_book($1,$2,$3) as result',[target,revision,payload === null ? null : JSON.stringify(payload)]);

test('preflight aborta antes de DDL quando conta falta, duplica ou nao esta confirmada', async () => {
  for (const defect of ['missing','duplicate','unconfirmed','case']) {
    const db = new PGlite();
    try {
      await setup(db);
      if (defect === 'missing') await db.query('delete from auth.users where id=$1',[talita]);
      if (defect === 'duplicate') await db.query("insert into auth.users values('44444444-4444-4444-8444-444444444444','talitapreviatti@gmail.com',now())");
      if (defect === 'unconfirmed') await db.query('update auth.users set email_confirmed_at=null where id=$1',[talita]);
      if (defect === 'case') await db.query("update auth.users set email='TalitaPreviatti@gmail.com' where id=$1",[talita]);
      await assert.rejects(db.exec(migration), /conta ausente, duplicada ou nao confirmada/);
      await db.exec('rollback');
      assert.equal((await db.query("select to_regclass('public.financas_books') as name")).rows[0].name,null);
      assert.equal((await db.query('select sentinel from financial_history')).rows[0].sentinel,'LEGACY UNTOUCHED');
    } finally { await db.close(); }
  }
});

test('RLS permite apenas Fabio e Talita ativos: admin, anon, perfil ausente e membership injetada negados', async () => {
  const db = new PGlite();
  try {
    await setup(db); await db.exec(migration);
    for (const actor of [fabio,talita]) {
      await asUser(db,actor);
      assert.equal((await db.query('select * from financas_books')).rows.length,1);
      assert.equal((await db.query('select * from financas_members')).rows.length,1);
      assert.equal((await save(db,actor===fabio?0:1)).rows[0].result.revision,actor===fabio?1:2);
      for (const table of ['financas_workspaces','financas_members','financas_books','financas_history']) {
        await assert.rejects(db.query(`delete from ${table}`),/permission denied/);
        await assert.rejects(db.query(`insert into ${table} select * from ${table}`),/permission denied/);
      }
      await assert.rejects(db.query('update financas_books set revision=99'),/permission denied/);
      await assert.rejects(db.query("update financas_members set role='editor'"),/permission denied/);
    }
    for (const actor of [admin,null]) {
      await asUser(db,actor);
      assert.equal((await db.query('select * from financas_books')).rows.length,0);
      assert.equal((await db.query('select * from financas_history')).rows.length,0);
      await assert.rejects(save(db,2),/Sem permissao/);
    }
    await asUser(db,null,'anon');
    await assert.rejects(db.query('select * from financas_books'),/permission denied/);
    await assert.rejects(save(db,2),/permission denied/);
    await db.exec('reset role');
    await db.query("insert into financas_members values($1,$2,'editor')",[workspace,admin]);
    await asUser(db,admin);
    assert.equal((await db.query('select * from financas_members')).rows.length,0);
    await assert.rejects(save(db,2),/Sem permissao/);
    await db.exec('reset role'); await db.query('delete from user_profiles where id=$1',[fabio]);
    await asUser(db,fabio); await assert.rejects(save(db,2),/Sem permissao/);
    await db.exec('reset role'); await db.query('update user_profiles set is_active=false where id=$1',[talita]);
    await asUser(db,talita); assert.equal((await db.query('select * from financas_books')).rows.length,0); await assert.rejects(save(db,2),/Sem permissao/);
    await db.exec('reset role'); await db.query('update user_profiles set is_active=true where id=$1',[talita]);
    await db.query("update auth.users set email='changed@example.com' where id=$1",[talita]);
    await asUser(db,talita); await assert.rejects(save(db,2),/Sem permissao/);
    await db.exec('reset role'); await db.query("update auth.users set email='talitapreviatti@gmail.com',email_confirmed_at=null where id=$1",[talita]);
    await asUser(db,talita); await assert.rejects(save(db,2),/Sem permissao/);
  } finally { await db.close(); }
});

test('RPC valida dominio, null/tamanho, conflitos e preserva historico e sentinela ao reaplicar', async () => {
  const db = new PGlite();
  try {
    await setup(db); await db.exec(migration);
    assert.deepEqual((await db.query('select payload from financas_books')).rows[0].payload,emptyState());
    await asUser(db,fabio);
    await assert.rejects(save(db,null),/Revisao obrigatoria/);
    await assert.rejects(save(db,-1),/Revisao obrigatoria/);
    await assert.rejects(save(db,0,null),/Estrutura financeira/);
    await assert.rejects(save(db,0,emptyState(),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),/Sem permissao/);
    const identity = { classification:'Despesa',category:'A',subcategory:'B',detail:'' };
    const transaction = { ...identity,id:'t',date:'2026-11-08',description:'Teste',source:'manual',sourceRow:null,amount:-123,balance:null,order:0 };
    const plan = { ...identity,id:'p',pix:'',notes:'',dueDay:1,amounts:{'2026-11':123},actualMonths:[],sourceRow:null };
    const payment = { id:'pay',name:'Teste',responsible:'',pix:'',holder:'',document:'',date:'',amount:0 };
    const invalidCases = [
      { schemaVersion:'1' }, { transactions:[null] }, { transactions:[{...transaction,date:'2026-02-31'}] },
      { transactions:[{...transaction,amount:'123'}] }, { transactions:[{...transaction,amount:.1}] },
      { transactions:[{...transaction,balance:1000000000000}] }, { transactions:[transaction,transaction] },
      { transactions:[{...transaction,classification:'ADMIN'}] }, { transactions:[{...transaction,order:null}] },
      { plans:[{...plan,dueDay:32}] }, { plans:[{...plan,amounts:{'2026-13':123}}] },
      { plans:[{...plan,amounts:{'2026-11':-1}}] }, { plans:[{...plan,actualMonths:['2026-12']}] },
      { payments:[payment,payment] }, { payments:[{...payment,amount:-1}] }, { payments:[{...payment,date:'2026-02-29'}] },
      { projection:{opening:0,adjustments:{'2026-11':{participation:null,other:0}}} },
      { bank:{...emptyState().bank,sequence:null} }, { bank:{...emptyState().bank,sequence:1000000} },
      { catalog:{income:[null],expense:[],children:{}} }, { transferNames:[123] },
      { source:{...emptyState().source,formulas:'1'} }, { issues:[{code:'A',sheet:'',cell:'',message:{}}] },
    ];
    for (const invalid of invalidCases) {
      const data = {...emptyState(),...invalid};
      assert.throws(()=>validateState(data));
      await assert.rejects(save(db,0,data));
    }
    const oversized = emptyState(); oversized.source.name = 'x'.repeat(16*1024*1024);
    await assert.rejects(save(db,0,oversized),/15 MB/);
    assert.equal((await db.query('select count(*)::int as count from financas_history')).rows[0].count,0);
    const next = emptyState(); next.transactions=[transaction];next.plans=[plan];next.payments=[payment];next.projection.opening=-100;
    validateState(next);
    assert.equal((await save(db,0,next)).rows[0].result.revision,1);
    await assert.rejects(save(db,0),/Outra sessao/);
    assert.deepEqual((await db.query('select payload from financas_history where revision=0')).rows[0].payload,emptyState());
    await asUser(db,talita); await save(db,1);
    const before = (await db.query('select * from financas_books')).rows;
    const history = (await db.query('select * from financas_history order by revision')).rows;
    await db.exec('reset role'); await db.exec(migration); await db.exec(migration);
    assert.deepEqual((await db.query('select * from financas_books')).rows,before);
    assert.deepEqual((await db.query('select * from financas_history order by revision')).rows,history);
    assert.equal((await db.query('select count(*)::int as count from financas_members')).rows[0].count,2);
    assert.equal((await db.query('select sentinel from financial_history')).rows[0].sentinel,'LEGACY UNTOUCHED');
  } finally { await db.close(); }
});