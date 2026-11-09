import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

await build({entryPoints:['api/financial/mais-envios.ts'],outfile:'tmp/mais-envios-tests/api.cjs',bundle:true,platform:'node',format:'cjs',packages:'external'})
const module=await import(pathToFileURL(`${process.cwd()}/tmp/mais-envios-tests/api.cjs`).href)
const handler=module.default.default??module.default

test('Mais Envios mail authenticates, uses immutable saved contact/PDF, restricts test recipients and reserves at most once',async()=>{
  const originalFetch=globalThis.fetch
  const names=['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','MAIL_PROVIDER','MAIL_FROM','MAIL_MS_TENANT_ID','MAIL_MS_CLIENT_ID','MAIL_MS_CLIENT_SECRET','MAIL_TEST_RECIPIENT']
  const original=Object.fromEntries(names.map(name=>[name,process.env[name]]))
  Object.assign(process.env,{SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-local-only',MAIL_PROVIDER:'microsoft365',MAIL_FROM:'remetente@example.invalid',MAIL_MS_TENANT_ID:'synthetic',MAIL_MS_CLIENT_ID:'local-only',MAIL_MS_CLIENT_SECRET:'local-only'})
  delete process.env.MAIL_TEST_RECIPIENT
  const user='11111111-1111-4111-8111-111111111111',closingId='22222222-2222-4222-8222-222222222222'
  const closing={id:closingId,period:'Outubro',subject:'Fechamento sintetico',body:'Mensagem sintetica',rows:[{id:crypto.randomUUID(),kind:'marketplace',period:'Outubro',values:['001','Pessoa','000','pessoa@example.invalid','Smart A','AB123456789BR','Loja','2026-10-01'],originalCode:'AB123456789BR',code:'AB123456789BR',smart:'Smart A',createdAt:'2026-10-01',valueCents:0,validity:'valid',manual:null}],contacts:[{smart:'Smart A',email:'destino@example.invalid',responsible:'Pessoa sintetica',registrationId:null}]}
  let active=true,manage=true,failProvider=false,failFinish=false
  const logs=[],deliveries=[],requests=[]
  globalThis.fetch=async(input,init)=>{
    const url=new URL(typeof input==='string'?input:input.url??String(input))
    const method=init?.method??input.method??'GET',body=init?.body?JSON.parse(typeof init.body==='string'?init.body:'null'):null
    requests.push(url.pathname)
    if(url.origin==='https://synthetic.supabase.co'){
      if(url.pathname==='/auth/v1/user')return Response.json({id:user,email:'admin@example.invalid'})
      if(url.pathname==='/rest/v1/user_profiles')return Response.json([{role:'operador',is_active:active}])
      if(url.pathname==='/rest/v1/user_module_permissions')return Response.json([{financeiro_manage:manage}])
      if(url.pathname==='/rest/v1/mais_envios_closings')return Response.json([closing])
      assert.equal(url.pathname,'/rest/v1/mais_envios_closing_mail')
      if(method==='POST'){
        if(logs.length)return Response.json({code:'23505'},{status:409})
        logs.push({id:crypto.randomUUID(),...body});return Response.json(logs[0],{status:201})
      }
      if(method==='PATCH'){
        if(failFinish)return Response.json({message:'local failure'},{status:503})
        Object.assign(logs[0],body);return new Response(null,{status:204})
      }
      return Response.json(logs)
    }
    if(url.origin==='https://login.microsoftonline.com')return Response.json({access_token:'synthetic-only'})
    assert.equal(url.origin,'https://graph.microsoft.com')
    if(failProvider)return Response.json({error:'local failure'},{status:503})
    deliveries.push(body.message)
    return new Response(null,{status:202})
  }
  const invoke=async(auth=true)=>{
    let status,payload
    const res={setHeader(){},status(value){status=value;return this},json(value){payload=value;return this}}
    await handler({method:'POST',headers:auth?{authorization:'Bearer synthetic'}:{},body:{closingId,smart:'smart a',email:'attacker@example.invalid',pdf:'forged'}},res)
    return{status,payload}
  }
  try{
    assert.equal((await invoke(false)).status,401);assert.equal(requests.length,0)
    active=false;assert.equal((await invoke()).status,403)
    active=true;manage=false;assert.equal((await invoke()).status,403)
    manage=true;process.env.MAIL_TEST_RECIPIENT='other@example.invalid';assert.equal((await invoke()).status,403);assert.equal(logs.length,0)
    delete process.env.MAIL_TEST_RECIPIENT
    const attempts=await Promise.all([invoke(),invoke()])
    assert.ok(attempts.every(attempt=>[200,409].includes(attempt.status)))
    assert.equal(deliveries.length,1);assert.equal(logs.length,1)
    assert.equal(deliveries[0].toRecipients[0].emailAddress.address,'destino@example.invalid')
    assert.ok(Buffer.from(deliveries[0].attachments[0].contentBytes,'base64').subarray(0,5).equals(Buffer.from('%PDF-')))
    assert.equal((await invoke()).payload.duplicate,true);assert.equal(deliveries.length,1)
    logs.length=0;failProvider=true
    assert.equal((await invoke()).status,502);assert.equal(logs[0].status,'incerto')
    assert.equal((await invoke()).status,409);assert.equal(deliveries.length,1)
    logs.length=0;failProvider=false;failFinish=true
    assert.equal((await invoke()).status,202)
    assert.equal((await invoke()).status,409)
  }finally{
    globalThis.fetch=originalFetch
    for(const name of names)if(original[name]===undefined)delete process.env[name];else process.env[name]=original[name]
  }
})