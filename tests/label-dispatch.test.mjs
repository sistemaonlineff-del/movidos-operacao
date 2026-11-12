import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSync } from 'esbuild'
import { readFile, readdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const compiled=buildSync({entryPoints:['src/labelDispatch.ts'],bundle:true,platform:'node',format:'esm',write:false})
const domain=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const extractionCode=buildSync({entryPoints:['src/labelExtraction.ts'],bundle:true,platform:'node',format:'esm',write:false})
const extraction=await import(`data:text/javascript;base64,${Buffer.from(extractionCode.outputFiles[0].text).toString('base64')}`)
test('OCR preserves nullable legacy fields and requires a complete certain destination for Maps',()=>{
  const legacy={recipient:{street:'Rua Sintetica',neighborhood:null,city:'Suzano',postalCode:'08600000'},warnings:[],uncertainFields:[]}
  const old=extraction.parseLabelExtraction(legacy)
  assert.equal(old.recipient.number,null);assert.equal(old.recipient.complement,null);assert.equal(old.recipient.neighborhood,null)
  assert.equal(extraction.labelDeliveryAddress(old).addressConfirmed,false)
  const complete=extraction.parseLabelExtraction({...legacy,recipient:{...legacy.recipient,number:'37',complement:'Casa 2'}})
  assert.equal(extraction.extractionQuery(complete),extraction.extractionQuery(old))
  assert.equal(extraction.labelDeliveryAddress(complete).packageAddress,'Rua Sintetica, 37, Casa 2, Suzano, 08600-000')
  assert.equal(extraction.labelDeliveryAddress(complete).addressConfirmed,true)
  complete.uncertainFields=['recipient.number'];assert.equal(extraction.labelDeliveryAddress(complete).addressConfirmed,false)
  assert.ok(!extraction.labelDeliveryAddress(complete).packageAddress.includes('37'))
  assert.throws(()=>extraction.parseLabelExtraction({...legacy,recipient:{...legacy.recipient,city:undefined}}),/Campo inválido/)
})
test('Maps export preserves all packages, curated order, mobile waypoint cap and continuity',()=>{
  const rows=Array.from({length:10},(_,index)=>({id:String(index),delivery_sequence:10-index,created_at:'2026-11-10T10:00:00Z',address_confirmed:true,recipient_address:`Rua Sintetica, ${index+1}, Cidade SP`}))
  const ordered=domain.orderedDispatch(rows),links=domain.dispatchMapsLinks(ordered,'Deposito, 100, Cidade SP')
  assert.equal(ordered[0].id,'9');assert.equal(links.length,3)
  const addresses=[];let previous='Deposito, 100, Cidade SP'
  for(const link of links){const url=new URL(link);assert.equal(url.searchParams.get('origin'),previous);const waypoints=url.searchParams.get('waypoints')?.split('|')??[];assert.ok(waypoints.length<=3);addresses.push(...waypoints,url.searchParams.get('destination'));previous=url.searchParams.get('destination')}
  assert.deepEqual(addresses,ordered.map(row=>row.recipient_address))
  assert.throws(()=>domain.dispatchMapsLinks([{...rows[0],address_confirmed:false}]),/Confira/)
})

test('dispatch migration preserves legacy data and permits only own reads to active reader accounts',async()=>{
  const db=new PGlite(),first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222'
  try{
    await db.exec(`create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create table user_profiles(id uuid primary key,is_active boolean,role text);create table user_module_permissions(user_id uuid,label_reader_access boolean default true);
      create table delivery_volumes(id uuid default gen_random_uuid(),delivery_date date,created_at timestamptz,driver_name text);
      alter table delivery_volumes enable row level security;
      insert into user_profiles values('${first}',true,'operador'),('${second}',true,'operador');insert into user_module_permissions values('${first}',true),('${second}',true);
      insert into delivery_volumes(driver_name) values('Legado');`)
    const sql=await readFile('supabase/migrations/20261110110000_label_driver_dispatch.sql','utf8')
    await db.exec(sql);await db.exec(sql)
    assert.equal((await db.query('select * from delivery_volumes')).rows[0].driver_name,'Legado')
    assert.deepEqual((await db.query('select label_reader_access from user_module_permissions')).rows.map(row=>row.label_reader_access),[true,true])
    await db.exec("insert into user_module_permissions(user_id) values(gen_random_uuid())")
    assert.equal((await db.query('select label_reader_access from user_module_permissions where user_id not in (select id from user_profiles)')).rows[0].label_reader_access,false)
    await db.exec(`insert into delivery_volumes(driver_id,driver_name) values('${first}','Bruno'),('${second}','Jose');select set_config('request.jwt.claim.sub','${first}',false);set role authenticated`)
    const own=(await db.query('select * from delivery_volumes')).rows
    assert.equal(own.length,1);assert.equal(own[0].driver_name,'Bruno')
    await assert.rejects(db.exec("update delivery_volumes set driver_name='Outro'"),/permission denied/)
    await db.exec(`reset role;update user_module_permissions set label_reader_access=false where user_id='${first}';set role authenticated`)
    assert.equal((await db.query('select * from delivery_volumes')).rows.length,0)
    await db.exec('reset role;set role anon');await assert.rejects(db.exec('select * from delivery_volumes'),/permission denied/)
  }finally{await db.close()}
})

test('dispatch permission migration creates a missing column without authorizing existing accounts',async()=>{
  const db=new PGlite(),driver='11111111-1111-4111-8111-111111111111'
  try{
    await db.exec(`create role authenticated;create schema auth;create function auth.uid() returns uuid language sql as $$select '${driver}'::uuid$$;
      create table user_profiles(id uuid primary key,is_active boolean,role text);
      create table user_module_permissions(user_id uuid);
      create table delivery_volumes(id uuid default gen_random_uuid(),delivery_date date,created_at timestamptz,driver_name text);
      alter table delivery_volumes enable row level security;
      insert into user_profiles values('${driver}',true,'operador');
      insert into user_module_permissions values('${driver}');
      insert into delivery_volumes(driver_name) values('Legado');`)
    const sql=await readFile('supabase/migrations/20261110110000_label_driver_dispatch.sql','utf8')
    await db.exec(sql);await db.exec(sql)
    assert.deepEqual((await db.query('select * from user_module_permissions')).rows,[{user_id:driver,label_reader_access:false}])
    assert.equal((await db.query('select driver_name from delivery_volumes')).rows[0].driver_name,'Legado')
    await db.exec(`update delivery_volumes set driver_id='${driver}';set role authenticated`)
    assert.equal((await db.query('select * from delivery_volumes')).rows.length,0)
    await db.exec(`reset role;update user_module_permissions set label_reader_access=true;set role authenticated`)
    assert.equal((await db.query('select * from delivery_volumes')).rows.length,1)
  }finally{await db.close()}
})

test('route delegation defaults off, preserves legacy access and requires an active authorized profile',async()=>{
  const db=new PGlite(),user='11111111-1111-4111-8111-111111111111'
  try{
    await db.exec(`create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create table user_profiles(id uuid primary key,email text,is_active boolean,role text);
      create table user_module_permissions(user_id uuid primary key,label_reader_access boolean default false);
      insert into user_profiles values('${user}','synthetic@example.invalid',true,'operador');
      insert into user_module_permissions values('${user}',true);
      select set_config('request.jwt.claim.sub','${user}',false);`)
    const sql=await readFile('supabase/migrations/20261111230000_delegated_route_management.sql','utf8')
    await db.exec(sql);await db.exec(sql)
    const allowed=async()=> (await db.query('select can_manage_delivery_routes() allowed')).rows[0].allowed
    assert.equal(await allowed(),false)
    assert.equal((await db.query('select label_reader_access from user_module_permissions')).rows[0].label_reader_access,true)
    await db.exec('update user_module_permissions set delivery_routes_manage=true')
    assert.equal(await allowed(),true)
    await db.exec('update user_profiles set is_active=false')
    assert.equal(await allowed(),false)
    await db.exec("update user_profiles set is_active=true;update user_module_permissions set delivery_routes_manage=false;update user_profiles set role='admin'")
    assert.equal(await allowed(),true)
    await db.exec("update user_profiles set role='operador',email='talitapreviatti@gmail.com'")
    assert.equal(await allowed(),true)
    await db.exec(`update user_profiles set email='synthetic@example.invalid';
      create table delivery_route_base(id integer primary key,street text);
      create table delivery_volumes(id integer primary key,street text);
      insert into delivery_route_base values(1,'Rua preservada');insert into delivery_volumes values(1,'Volume preservado');
      alter table delivery_route_base enable row level security;alter table delivery_volumes enable row level security;
      create policy delivery_route_base_manage on delivery_route_base for all to authenticated using(can_manage_delivery_routes()) with check(can_manage_delivery_routes());
      create policy delivery_volumes_manage on delivery_volumes for all to authenticated using(can_manage_delivery_routes()) with check(can_manage_delivery_routes());
      grant select,insert,update,delete on delivery_route_base,delivery_volumes to authenticated;
      alter table user_module_permissions enable row level security;
      create policy permissions_own_read on user_module_permissions for select to authenticated using(user_id=auth.uid());
      grant select,update on user_module_permissions to authenticated;
      set role authenticated;`)
    assert.equal((await db.query('select * from delivery_route_base')).rows.length,0)
    await assert.rejects(db.exec("insert into delivery_route_base values(2,'Negado')"),/row-level security/)
    await db.exec('update user_module_permissions set delivery_routes_manage=true')
    assert.equal(await allowed(),false)
    await db.exec('reset role;update user_module_permissions set delivery_routes_manage=true;set role authenticated')
    assert.equal((await db.query('select street from delivery_route_base')).rows[0].street,'Rua preservada')
    assert.equal((await db.query('select street from delivery_volumes')).rows[0].street,'Volume preservado')
    await db.exec("update delivery_route_base set street='Edicao autorizada' where id=1;reset role;update user_module_permissions set delivery_routes_manage=false;set role authenticated")
    assert.equal((await db.query('select * from delivery_volumes')).rows.length,0)
    await db.exec('reset role')
    assert.equal((await db.query('select street from delivery_route_base')).rows[0].street,'Edicao autorizada')
    await db.exec('set role anon')
    await assert.rejects(allowed(),/permission denied/)
  }finally{await db.close()}
})

test('Vercel Hobby stays within 12 functions and preserves the dispatch URL before the SPA fallback',async()=>{
  const entries=(await readdir('api',{recursive:true})).filter(name=>/\.(?:[cm]?js|ts|py|go|rb|php)$/.test(name)&&!name.endsWith('.d.ts'))
  assert.ok(entries.length<=12,`${entries.length} serverless function entrypoints`)
  assert.ok(!entries.includes('label-dispatch.ts'))
  const config=JSON.parse(await readFile('vercel.json','utf8')),rule=config.rewrites[0]
  assert.equal(rule.source,'/api/label-dispatch')
  const target=new URL(rule.destination,'https://example.invalid')
  assert.equal(target.pathname,'/api/label-volume');assert.equal(target.searchParams.get('__labelDispatch'),'1')
  assert.deepEqual(config.rewrites.at(-1),{source:'/(.*)',destination:'/index.html'})
})

test('dispatch API scopes own lists, denies cross-driver writes, preserves assignments on retry and validates Google results',async()=>{
  buildSync({entryPoints:{'label-dispatch':'server/label-dispatch.ts','label-volume':'api/label-volume.ts'},outdir:'tmp/label-dispatch',outExtension:{'.js':'.cjs'},bundle:true,platform:'node',format:'cjs',packages:'external'})
  const load=async name=>{const module=await import(pathToFileURL(`${process.cwd()}/tmp/label-dispatch/${name}.cjs`));return module.default.default??module.default}
  const dispatch=await load('label-dispatch'),volume=await load('label-volume')
  const originalFetch=globalThis.fetch,env={...process.env},first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222'
  let active=true,role='operador',googleCalls=0,indices=[0]
  const rows=[{id:'33333333-3333-4333-8333-333333333333',driver_id:first,driver_name:'Bruno',recipient_address:'Rua A, 10, Suzano SP',address_confirmed:true,delivery_sequence:1,created_at:'2026-11-10T10:00:00Z',scan_key:'first-scan-key-123456',delivery_date:'2026-11-10'},{id:'44444444-4444-4444-8444-444444444444',driver_id:first,driver_name:'Bruno',recipient_address:'Rua B, 20, Suzano SP',address_confirmed:true,delivery_sequence:2,created_at:'2026-11-10T10:00:01Z',scan_key:'second-scan-key-123456',delivery_date:'2026-11-10'},{id:'55555555-5555-4555-8555-555555555555',driver_id:second,driver_name:'Jose',recipient_address:'Rua C, 30, Suzano SP',address_confirmed:true,delivery_sequence:3,created_at:'2026-11-10T10:00:02Z',scan_key:'third-scan-key-123456',delivery_date:'2026-11-10'}]
  const invoke=async(handler,body,method='GET',query={day:'2026-11-10'})=>{let result;await handler({method,query,body,headers:{authorization:'Bearer synthetic'}},{setHeader(){},status(code){this.code=code;return this},json(body){result={status:this.code,body};return this}});return result}
  try{
    Object.assign(process.env,{SUPABASE_URL:'https://dispatch-test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',GOOGLE_ROUTES_API_KEY:'synthetic-google-key'})
    globalThis.fetch=async(input,init)=>{
      const url=new URL(typeof input==='string'?input:input.url??String(input)),body=typeof init?.body==='string'?JSON.parse(init.body):null
      if(url.hostname==='routes.googleapis.com'){googleCalls++;assert.equal(new Headers(init.headers).get('X-Goog-Api-Key'),'synthetic-google-key');assert.equal(body.optimizeWaypointOrder,true);assert.equal(body.travelMode,'DRIVE');return Response.json({routes:[{optimizedIntermediateWaypointIndex:indices}]})}
      assert.equal(url.hostname,'dispatch-test.supabase.co')
      if(url.pathname==='/auth/v1/user')return Response.json({id:first,email:'bruno@example.invalid'})
      if(url.pathname.endsWith('/user_profiles'))return Response.json(url.searchParams.has('id')?[{id:url.searchParams.get('id').slice(3),role:url.searchParams.get('id')===`eq.${first}`?role:'operador',is_active:active,full_name:url.searchParams.get('id')===`eq.${first}`?'Bruno':'Jose'}]:[{id:first,full_name:'Bruno',role},{id:second,full_name:'Jose',role:'operador'}])
      if(url.pathname.endsWith('/user_module_permissions'))return Response.json(url.searchParams.has('user_id')?[{label_reader_access:true}]:[{user_id:first},{user_id:second}])
      if(url.pathname.endsWith('/delivery_route_base'))return Response.json([{street:'Rua C',city:'Suzano',postal_code:'00000-000',zone:'Norte',route:'R1',delivery_sequence:3}])
      if(url.pathname.endsWith('/delivery_volumes')){
        let filtered=rows.filter(row=>['driver_id','delivery_date','scan_key','id'].every(key=>!url.searchParams.get(key)?.startsWith('eq.')||row[key]===url.searchParams.get(key).slice(3)))
        if(init?.method==='POST'){rows.push({...body,id:crypto.randomUUID(),created_at:'2026-11-10T10:00:03Z'});return new Response(null,{status:201})}
        if(init?.method==='PATCH'){filtered.forEach(row=>Object.assign(row,body));return new Response(null,{status:204})}
        if(init?.method==='HEAD')return new Response(null,{headers:{'Content-Range':`0-0/${filtered.length}`}})
        if(url.searchParams.get('limit')==='1')filtered=filtered.slice(0,1)
        return Response.json(filtered)
      }
      assert.fail(`Unexpected endpoint ${url.pathname}`)
    }
    assert.equal((await invoke(dispatch,null,'GET',{day:'2026-02-31'})).status,400)
    let response=await invoke(dispatch);assert.equal(response.status,200);assert.equal(response.body.rows.length,2);assert.equal(response.body.drivers.length,1)
    const throughRewrite=await invoke(volume,null,'GET',{day:'2026-11-10',__labelDispatch:'1'})
    assert.equal(throughRewrite.status,200);assert.deepEqual(throughRewrite.body,response.body)
    assert.equal((await invoke(volume,{mode:'confirm-address',day:'2026-11-10',id:rows[0].id,address:'Rua A, 11, Suzano SP'},'POST',{__labelDispatch:'1'})).status,200)
    assert.equal(rows[0].recipient_address,'Rua A, 11, Suzano SP')
    assert.equal((await invoke(volume,null,'GET',{day:'2026-11-10',__labelDispatch:'1',driverId:second})).status,403)
    assert.equal((await invoke(dispatch,null,'GET',{day:'2026-11-10',driverId:second})).status,403)
    assert.equal((await invoke(dispatch,{mode:'confirm-address',day:'2026-11-10',id:rows[2].id,address:'forged'},'POST')).status,400)
    const payload={baseId:'base-1',scanKey:'new-scan-key-123456',driverId:second,packageAddress:'Rua C, 30, Suzano SP',addressConfirmed:true}
    assert.equal((await invoke(volume,payload,'POST')).status,403)
    role='admin';response=await invoke(dispatch);assert.equal(response.body.rows.length,3);assert.equal(response.body.drivers.length,2)
    assert.equal((await invoke(volume,payload,'POST')).status,201)
    const saved=rows.at(-1);assert.equal(saved.driver_id,second);assert.equal(saved.created_by,first);assert.equal(saved.recipient_address,payload.packageAddress)
    assert.equal((await invoke(volume,payload,'POST')).body.duplicate,true)
    assert.equal((await invoke(volume,{...payload,driverId:first},'POST')).status,409)
    response=await invoke(dispatch,{mode:'optimize',day:'2026-11-10',driverId:first,origin:'Deposito, 100, Suzano SP'},'POST')
    assert.equal(response.status,200);assert.deepEqual(response.body.ids,rows.slice(0,2).map(row=>row.id));assert.equal(googleCalls,1)
    indices=[99];assert.equal((await invoke(dispatch,{mode:'optimize',day:'2026-11-10',driverId:first,origin:'Deposito'},'POST')).status,502)
    active=false;assert.equal((await invoke(dispatch)).status,403)
    assert.equal((await invoke(volume,null,'GET',{day:'2026-11-10',__labelDispatch:'1'})).status,403)
  }finally{globalThis.fetch=originalFetch;for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env)}
})