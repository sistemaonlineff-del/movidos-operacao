import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

await build({entryPoints:['api/drop-registration.ts'],outfile:'tmp/drop-registration/api.cjs',bundle:true,platform:'node',format:'cjs',packages:'external'})
await build({entryPoints:['src/dropRegistrationFiles.ts'],outfile:'tmp/drop-registration/files.cjs',bundle:true,platform:'node',format:'cjs',packages:'external'})
const module=await import(pathToFileURL(`${process.cwd()}/tmp/drop-registration/api.cjs`)),handler=module.default.default??module.default
const {registrationFiles}=await import(pathToFileURL(`${process.cwd()}/tmp/drop-registration/files.cjs`))
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
const id='ab222222-2222-4222-8222-222222222222'
const snapshot={name:'Drop Teste',responsible:'Pessoa Teste',phone:'11999999999',address:'Rua Teste',address_number:'10',neighborhood:'Centro',municipality:'Suzano',state:'SP',postal_code:'08600000',pix_key:'teste@example.invalid',pix_holder_name:'Pessoa Teste',latitude:-23.5,longitude:-46.3}

test('photo signatures, dimensions, duplicate content, SVG, oversized and external URLs are rejected',()=>{
  assert.equal(registrationFiles([{content:png}])[0].width,1)
  for (const photos of [[],[{content:'https://example.invalid/photo.png'}],[{content:Buffer.from('<svg></svg>').toString('base64')}],[{content:png},{content:png}],[{content:'a'.repeat(3000000)}]]) assert.throws(()=>registrationFiles(photos))
  const bomb=Buffer.from(png,'base64');bomb.writeUInt32BE(20000,16)
  assert.throws(()=>registrationFiles([{content:bomb.toString('base64')}]))
  const noPngData=Buffer.concat([Buffer.from(png,'base64').subarray(0,33),Buffer.from(png,'base64').subarray(-12)])
  assert.throws(()=>registrationFiles([{content:noPngData.toString('base64')}]),/PNG/)
  const webpHeader=Buffer.alloc(30);webpHeader.write('RIFF',0);webpHeader.writeUInt32LE(22,4);webpHeader.write('WEBPVP8X',8);webpHeader.writeUInt32LE(10,16)
  assert.throws(()=>registrationFiles([{content:webpHeader.toString('base64')}]))
})

test('API private submit recovers uploads/lost response and passes only the server-verified actor to service-only approval',async()=>{
  const env={...process.env},fetch=globalThis.fetch
  let record=null,files=new Map(),failUpload=true,active=true,role='admin',allowed=true,failFinalize=false,reserved=true,authToken='',dropWrites=0
  const invoke=async(body,auth=false,method='POST')=>{
    let result
    await handler({body,method,query:{},headers:auth?{authorization:'Bearer synthetic-user'}:{}},{setHeader(){},status(code){this.code=code;return this},json(body){result={status:this.code,body};return this}})
    return result
  }
  try {
    Object.assign(process.env,{SUPABASE_URL:'https://drop-test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',SUPABASE_ANON_KEY:'synthetic-anon'})
    globalThis.fetch=async(input,init)=>{
      const url=new URL(typeof input==='string'?input:input.url??String(input)),body=typeof init?.body==='string'?JSON.parse(init.body):null
      assert.equal(url.host,'drop-test.supabase.co')
      if(url.pathname==='/auth/v1/user')return Response.json({id:'11111111-1111-4111-8111-111111111111'})
      if(url.pathname.endsWith('/user_profiles'))return Response.json([{role,is_active:active}])
      if(url.pathname.endsWith('/user_module_permissions'))return Response.json([{cadastros_create:allowed,cadastros_edit:allowed}])
      if(url.pathname.endsWith('/rpc/drop_registration_authorize')){assert.equal(body.actor_id,'11111111-1111-4111-8111-111111111111');return Response.json(null)}
      if(url.pathname.endsWith('/rpc/drop_registration_reserve')){
        assert.match(body.ip_key,/^[a-f0-9]{64}$/);assert.equal(body.submission.is_active,undefined)
        if(!reserved)return Response.json(null)
        if(record&&record.content_hash!==body.digest)return Response.json({code:'23505'},{status:409})
        record??={id:body.client_id,snapshot:body.submission,photos:body.manifest,content_hash:body.digest,status:'uploading',revision:0}
        return Response.json(record)
      }
      if(url.pathname.includes('/storage/v1/object/drop-registration-private/')){
        if(init?.method==='POST'){
          if(failUpload)return Response.json({message:'unavailable'},{status:503})
          if(files.has(url.pathname))return Response.json({message:'exists'},{status:409})
          files.set(url.pathname,Buffer.from(png,'base64'));return Response.json({Key:'private'})
        }
        return files.has(url.pathname)?new Response(files.get(url.pathname)):Response.json({message:'missing'},{status:404})
      }
      if(url.pathname.endsWith('/rpc/drop_registration_finalize')){
        if(failFinalize)return Response.json({message:'unavailable'},{status:503})
        record.status='pending';record.revision=1;return Response.json(true)
      }
      if(url.pathname.endsWith('/drop_registration_intake'))return Response.json(record?[record]:[])
      if(url.pathname.endsWith('/rpc/drop_registration_review')){
        authToken=new Headers(init.headers).get('authorization');assert.equal(body.created_by,undefined)
        assert.equal(body.actor_id,'11111111-1111-4111-8111-111111111111')
        if(record.status!=='approved')dropWrites++
        record.status='approved';return Response.json({status:'approved',dropId:id})
      }
      assert.fail(`Unexpected endpoint ${url.pathname}`)
    }
    assert.equal((await invoke(null,false,'GET')).status,401)
    const payload={mode:'submit-public',clientId:id,consent:true,snapshot,photos:[{content:png,fileName:'../../photo.svg',caption:'Fachada'}]}
    assert.equal((await invoke({...payload,snapshot:{...snapshot,is_active:true,status:'ATIVO'}})).status,400)
    assert.equal((await invoke({...payload,padding:'x'.repeat(4_500_001)})).status,413)
    assert.equal((await invoke({...payload,consent:false})).status,400)
    reserved=false;assert.equal((await invoke(payload)).status,429);reserved=true
    const incomplete=await invoke(payload);assert.equal(incomplete.status,202);assert.equal(incomplete.body.status,'uploading');assert.equal(record.status,'uploading')
    assert.equal(incomplete.body.snapshot,undefined);assert.equal(incomplete.body.photos,undefined)
    failUpload=false;failFinalize=true;assert.equal((await invoke(payload)).status,202);assert.equal(files.size,1)
    const storedPath=[...files.keys()][0],originalBytes=files.get(storedPath)
    const tampered=Buffer.from(originalBytes);tampered[45]^=1;files.set(storedPath,tampered)
    failFinalize=false;assert.equal((await invoke(payload)).status,202);assert.equal(record.status,'uploading')
    files.set(storedPath,originalBytes)
    assert.equal((await invoke({...payload,clientId:id.toUpperCase()})).body.status,'pending');assert.equal(files.size,1)
    assert.deepEqual((await invoke(payload)).body,{status:'pending',protocol:id})
    assert.equal((await invoke({...payload,snapshot:{...snapshot,name:'Outro'}})).status,409)
    assert.equal((await invoke({...payload,photos:[{...payload.photos[0],fileName:'outro-nome.png'}]})).status,409)
    const approve={mode:'approve',id,revision:1,snapshot,actor_id:'99999999-9999-4999-8999-999999999999'}
    assert.equal((await invoke(approve)).status,401)
    active=false;assert.equal((await invoke(approve,true)).status,403);active=true
    role='operador';allowed=false;assert.equal((await invoke(approve,true)).status,403);allowed=true
    assert.equal((await invoke(approve,true)).status,200);assert.equal(authToken,'Bearer synthetic-service')
    assert.equal((await invoke(approve,true)).status,200);assert.equal(dropWrites,1)
    assert.equal((await invoke({mode:'duplicates',snapshot})).status,401)
  } finally {globalThis.fetch=fetch;for(const name of Object.keys(process.env))if(!(name in env))delete process.env[name];Object.assign(process.env,env)}
})