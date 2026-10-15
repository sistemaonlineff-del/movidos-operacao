import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

await build({entryPoints:['api/financial/invoices.ts'],outfile:'tmp/invoice-tests/api.cjs',bundle:true,platform:'node',format:'cjs',packages:'external'})
const module=await import(pathToFileURL(`${process.cwd()}/tmp/invoice-tests/api.cjs`).href)
const handler=module.default.default??module.default
const {invoiceFile}=module
const pdf=Buffer.from('%PDF-1.7\nTest invoice\n%%EOF').toString('base64')
test('invoice files validate extension, content, size and prohibit XML entities',()=>{
  assert.equal(invoiceFile({fileName:'NF.pdf',content:pdf}).type,'application/pdf')
  assert.equal(invoiceFile({fileName:'NF.xml',content:Buffer.from('<nfeProc><NFe><infNFe>nota</infNFe></NFe></nfeProc>').toString('base64')}).type,'application/xml')
  for(const content of ['<NFe>','<!DOCTYPE x [<!ENTITY x SYSTEM "file:///secret">]><NFe>&x;</NFe>','<notNF>text</notNF>'])assert.throws(()=>invoiceFile({fileName:'NF.xml',content:Buffer.from(content).toString('base64')}))
  assert.throws(()=>invoiceFile({fileName:'NF.exe',content:pdf}))
  assert.throws(()=>invoiceFile({fileName:'NF.pdf',content:'a'.repeat(4194305)}))
})

test('invoice API binds token to registered closing, blocks viewers and keeps duplicate receipts immutable',async()=>{
  const originalEnv={...process.env},originalFetch=globalThis.fetch
  const periodId='22222222-2222-4222-8222-222222222222',dropId='33333333-3333-4333-8333-333333333333',requestId='44444444-4444-4444-8444-444444444444'
  let role='admin',request=null,file=null,storageWrites=0,member=true,active=true,dropPartner='IMILE DELIVERY BRAZIL LTDA',ambiguous=false,failConfirmation=false,linkedSnapshot=false
  const invoke=async(body,token,method=body?'POST':'GET',auth=true)=>{
    let result
    const response={setHeader(){},status(status){this.code=status;return this},json(body){result={status:this.code,body};return this}}
    await handler({method,headers:{...(auth?{authorization:'Bearer test-only'}:{}),...(token?{'x-invoice-token':token}:{})},body},response)
    return result
  }
  try{
    Object.assign(process.env,{SUPABASE_URL:'https://invoices-test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-only'})
    globalThis.fetch=async(input,init)=>{
      const url=new URL(typeof input==='string'?input:input.url??String(input))
      assert.equal(url.hostname,'invoices-test.supabase.co')
      if(url.pathname==='/auth/v1/user')return Response.json({id:'11111111-1111-4111-8111-111111111111'})
      if(url.pathname.endsWith('/user_profiles'))return Response.json([{role,is_active:true}])
      if(url.pathname.endsWith('/user_module_permissions'))return Response.json([{financeiro_view:true,financeiro_manage:false}])
      if(url.pathname.endsWith('/financial_periods'))return Response.json(active?[{id:periodId,label:'35. 1Q',partner:'IMILE DELIVERY BRAZIL LTDA',reference_cnpj:'BELLY'}]:[])
      if(url.pathname.endsWith('/drops'))return Response.json([{id:dropId,name:'DROP',partner:dropPartner},...(!url.searchParams.has('id')&&ambiguous?[{id:'other',name:'DROP',partner:dropPartner}]:[])])
      if(url.pathname.endsWith('/financial_drop_items'))return Response.json(member&&(!url.searchParams.has('registration_snapshot')||linkedSnapshot)?[{id:'item'}]:[])
      if(url.pathname.endsWith('/financial_payment_history'))return Response.json([])
      if(url.pathname.includes('/storage/v1/object/financial-invoices/')){if(init?.method==='GET')return new Response(Buffer.from(pdf,'base64'));storageWrites++;return Response.json({Key:'stored'})}
      if(url.pathname.endsWith('/financial_invoice_requests')){
        if(init?.method==='POST'){request={id:requestId,...JSON.parse(init.body)};return Response.json({id:requestId})}
        if(init?.method==='PATCH'){Object.assign(request,JSON.parse(init.body));return Response.json({id:requestId})}
        const tokenHash=url.searchParams.get('token_hash')
        return Response.json(request&&(!tokenHash||tokenHash===`eq.${request.token_hash}`)?[request]:[])
      }
      assert.ok(url.pathname.endsWith('/financial_invoice_files'))
      if(init?.method==='POST'){
        if(file)return Response.json({code:'23505'},{status:409})
        file=JSON.parse(init.body);return Response.json(file)
      }
      if(init?.method==='PATCH'){if(failConfirmation)return Response.json({message:'Simulated confirmation failure'},{status:503});Object.assign(file,JSON.parse(init.body));return Response.json(file)}
      return Response.json(file?[file]:[])
    }
    assert.equal((await invoke(undefined,undefined,'GET',false)).status,401)
    role='operador';assert.equal((await invoke({mode:'create',periodId,dropId})).status,403)
    assert.equal((await invoke()).status,200)
    role='admin';member=false;assert.equal((await invoke({mode:'create',periodId,dropId})).status,400)
    member=true;dropPartner='J&T EXPRESS BRAZIL LTDA';assert.equal((await invoke({mode:'create',periodId,dropId})).status,400)
    dropPartner='IMILE DELIVERY BRAZIL LTDA';ambiguous=true;assert.equal((await invoke({mode:'create',periodId,dropId})).status,400)
    linkedSnapshot=true;assert.equal((await invoke({mode:'create',periodId,dropId})).status,200);linkedSnapshot=false;ambiguous=false
    const created=await invoke({mode:'create',periodId,dropId})
    assert.equal(created.status,200)
    const token=created.body.token
    assert.equal(request.token_hash,createHash('sha256').update(token).digest('hex'))
    assert.notEqual(request.token_hash,token)
    const info=await invoke(undefined,token,'GET',false)
    assert.equal(info.body.referenceCnpj,'BELLY');assert.equal(info.body.token_hash,undefined)
    assert.equal((await invoke(undefined,'a'.repeat(64),'GET',false)).status,410)
    const payload={mode:'upload',clientUploadId:'55555555-5555-4555-8555-555555555555',fileName:'NF.pdf',content:pdf,periodId:'forged',dropId:'forged'}
    assert.equal((await invoke(payload,token,'POST',false)).body.status,'received')
    assert.equal(file.request_id,requestId);assert.equal(storageWrites,1)
    assert.equal((await invoke(payload,token,'POST',false)).body.duplicate,true)
    assert.equal(storageWrites,1)
    file=null;failConfirmation=true
    assert.equal((await invoke({...payload,clientUploadId:'66666666-6666-4666-8666-666666666666'},token,'POST',false)).status,202)
    assert.equal(file.status,'uploading');failConfirmation=false
    role='operador';assert.equal((await invoke({mode:'reconcile',fileId:file.id})).status,403)
    role='admin';assert.equal((await invoke({mode:'reconcile',fileId:file.id})).body.status,'received')
    assert.equal(file.status,'received');assert.equal(storageWrites,2)
    request.expires_at='2000-01-01';assert.equal((await invoke(payload,token,'POST',false)).status,410)
    request.expires_at='2100-01-01';active=false;assert.equal((await invoke(payload,token,'POST',false)).status,410)
    active=true;await invoke({mode:'revoke',requestId});assert.equal((await invoke(payload,token,'POST',false)).status,410)
    assert.equal(storageWrites,2)
  }finally{globalThis.fetch=originalFetch;for(const key of Object.keys(process.env))if(!(key in originalEnv))delete process.env[key];Object.assign(process.env,originalEnv)}
})