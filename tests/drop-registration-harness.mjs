import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

export async function startDropRegistrationHarness() {
  const state={records:[],files:new Map(),failUpload:false,failFinalize:false,failList:false,active:true,role:'admin',allowed:true,dropWrites:0,requests:[],lastIpKey:null}
  const env={...process.env},originalFetch=globalThis.fetch
  const plugin={name:'isolated-drop-registration',setup(builder){
    builder.onResolve({filter:/^\.\/(access|lib\/supabase)$/},args=>({path:args.path,namespace:'drop-test'}))
    builder.onLoad({filter:/.*/,namespace:'drop-test'},args=>({contents:args.path==='./access'?
      'export const useAccess=()=>globalThis.__dropTest.access':
      'export const supabase={auth:{getSession:async()=>({data:{session:{access_token:"synthetic-user"}}})}}'}))
  }}
  const bundle=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import Public from './src/PublicDropRegistration';import Review,{DropRegistrationLinkActions}from './src/DropRegistrationReview';
    globalThis.__dropTest??={access:{profile:{role:'admin',is_active:true},permissions:{},loading:false}};
    const root=createRoot(document.getElementById('root'));globalThis.__dropTestUnmount=()=>root.unmount();root.render(location.pathname==='/cadastrar-drop'?<Public/>:<Review onApproved={id=>globalThis.__approvedDrop=id}/>);`,resolveDir:process.cwd(),loader:'tsx'},
    outfile:'tmp/drop-registration/browser.js',bundle:true,write:false,jsx:'automatic',format:'esm',platform:'browser',loader:{'.woff': 'dataurl','.woff2':'dataurl'},define:{'process.env.NODE_ENV':'"production"'},plugins:[plugin]})
  const script=bundle.outputFiles.find(file=>file.path.endsWith('.js')).contents,css=bundle.outputFiles.find(file=>file.path.endsWith('.css')).contents
  await build({entryPoints:['api/drop-registration.ts'],outfile:'tmp/drop-registration/browser-api.cjs',bundle:true,platform:'node',format:'cjs',packages:'external'})
  const module=await import(pathToFileURL(`${process.cwd()}/tmp/drop-registration/browser-api.cjs`)),handler=module.default.default??module.default
  Object.assign(process.env,{SUPABASE_URL:'https://synthetic-drop.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',SUPABASE_ANON_KEY:'synthetic-anon'})
  globalThis.fetch=async(input,init)=>{
    const url=new URL(typeof input==='string'?input:input.url??String(input)),body=typeof init?.body==='string'?JSON.parse(init.body):null
    assert.equal(url.host,'synthetic-drop.supabase.co','No real network allowed')
    state.requests.push({path:url.pathname,method:init?.method??'GET',body})
    if(url.pathname==='/auth/v1/user')return Response.json({id:'11111111-1111-4111-8111-111111111111'})
    if(url.pathname.endsWith('/user_profiles'))return Response.json([{role:state.role,is_active:state.active}])
    if(url.pathname.endsWith('/user_module_permissions'))return Response.json([{cadastros_create:state.allowed,cadastros_edit:state.allowed}])
    if(url.pathname.endsWith('/rpc/drop_registration_authorize')){assert.equal(body.actor_id,'11111111-1111-4111-8111-111111111111');return state.active?Response.json(null):Response.json({code:'42501'},{status:403})}
    if(url.pathname.endsWith('/rpc/drop_registration_reserve')){
      state.lastIpKey=body.ip_key
      let record=state.records.find(row=>row.id===body.client_id)
      if(record&&record.content_hash!==body.digest)return Response.json({code:'23505'},{status:409})
      if(!record){record={id:body.client_id,snapshot:body.submission,review_snapshot:null,photos:body.manifest,content_hash:body.digest,status:'uploading',revision:0,created_at:'2026-11-08T14:00:00Z',approved_drop_id:null,review_note:null};state.records.push(record)}
      return Response.json(record)
    }
    if(url.pathname.endsWith('/rpc/drop_registration_finalize')){
      if(state.failFinalize)return Response.json({message:'unconfirmed'},{status:503})
      const record=state.records.find(row=>row.id===body.client_id)
      record.status='pending';record.revision++;return Response.json(true)
    }
    if(url.pathname.endsWith('/rpc/drop_registration_duplicates'))return Response.json({matches:[],acknowledgment:'synthetic-empty'})
    if(url.pathname.endsWith('/rpc/drop_registration_review')){
      assert.equal(new Headers(init.headers).get('authorization'),'Bearer synthetic-service')
      assert.equal(body.actor_id,'11111111-1111-4111-8111-111111111111')
      const record=state.records.find(row=>row.id===body.submission_id)
      if(record.status==='approved'&&body.action==='approve')return Response.json({status:'approved',dropId:record.approved_drop_id})
      if(record.revision!==body.expected_revision)return Response.json({code:'40001'},{status:409})
      record.revision++;record.review_snapshot=body.submission;record.review_note=body.note
      if(body.action==='approve'){record.status='approved';record.approved_drop_id='44444444-4444-4444-8444-444444444444';state.dropWrites++}
      if(body.action==='reject')record.status='rejected'
      return Response.json({status:record.status,dropId:record.approved_drop_id})
    }
    if(url.pathname.endsWith('/drop_registration_intake')){
      if(state.failList)return Response.json({message:'offline'},{status:503})
      const id=url.searchParams.get('id')?.slice(3)
      return Response.json(id?state.records.filter(row=>row.id===id):state.records)
    }
    if(url.pathname.includes('/storage/v1/object/drop-registration-private/')){
      const path=url.pathname.split('/drop-registration-private/')[1]
      if(init?.method==='POST'){
        if(state.failUpload)return Response.json({message:'offline'},{status:503})
        if(state.files.has(path))return Response.json({message:'exists'},{status:409})
        const bytes=Buffer.from(await new Response(init.body).arrayBuffer());state.files.set(path,bytes);return Response.json({Key:path})
      }
      return state.files.has(path)?new Response(state.files.get(path)):Response.json({message:'missing'},{status:404})
    }
    if(url.pathname.includes('/storage/v1/object/sign/drop-registration-private/')){
      const path=url.pathname.split('/drop-registration-private/')[1]
      return Response.json({signedURL:`/object/sign/drop-registration-private/${path}?token=synthetic`})
    }
    assert.fail(`Unexpected API request ${url.pathname}`)
  }
  const server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://127.0.0.1')
      if(url.pathname==='/bundle.js'){res.setHeader('Content-Type','text/javascript');return res.end(script)}
      if(url.pathname==='/bundle.css'){res.setHeader('Content-Type','text/css');return res.end(css)}
      if(url.pathname.startsWith('/brand/')){res.setHeader('Content-Type','image/png');return res.end(await readFile(`public${url.pathname}`))}
      if(url.pathname.startsWith('/__private-photo/')&&url.searchParams.get('token')==='synthetic'){
        const path=decodeURIComponent(url.pathname.slice('/__private-photo/'.length)),bytes=state.files.get(path)
        if(!bytes){res.statusCode=404;return res.end('missing synthetic photo')}
        res.setHeader('Content-Type','image/jpeg');return res.end(bytes)
      }
      if(url.pathname==='/api/drop-registration'){
        const chunks=[];for await(const chunk of req)chunks.push(chunk)
        req.body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;req.query=Object.fromEntries(url.searchParams)
        res.status=code=>{res.statusCode=code;return res};res.json=value=>{
          if(value.url?.startsWith('https://synthetic-drop.supabase.co/storage/v1/object/sign/drop-registration-private/'))value={...value,url:`/__private-photo/${value.url.split('/drop-registration-private/')[1]}`}
          res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(value))
        }
        return await handler(req,res)
      }
      res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="pt-BR"><head><meta name="viewport" content="width=980"><link rel="stylesheet" href="/bundle.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>')
    }catch(error){res.statusCode=500;res.end(String(error))}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const base=`http://127.0.0.1:${server.address().port}`
  return {state,base,async close(){await new Promise(resolve=>server.close(resolve));globalThis.fetch=originalFetch;for(const name of Object.keys(process.env))if(!(name in env))delete process.env[name];Object.assign(process.env,env)}}
}

if(process.argv.includes('--preview')){
  const harness=await startDropRegistrationHarness()
  console.log(`SYNTHETIC LOCAL ONLY: ${harness.base}/cadastrar-drop | ${harness.base}/review`)
}