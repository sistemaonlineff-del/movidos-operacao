import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import * as XLSX from 'xlsx'
import { readFile } from 'node:fs/promises'

const origin=process.env.LABEL_BASE_URL||'http://127.0.0.1:5174'
const user={id:'11111111-1111-4111-8111-111111111111',email:'motorista@example.invalid',aud:'authenticated'}
const token=['local',Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'test'].join('.')
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']})
const diagnostics=[]
await mkdir('tmp/label-reader/screenshots',{recursive:true})
async function fixture({logged=true,active=true,allowed=true,routesAllowed=false,mobile=true,role='operador',path='/bipar',dispatchScenario=false,dispatchUnavailable=false,routeVariant='single'}={}) {
  const context=await browser.newContext({viewport:{width:mobile?390:1440,height:mobile?844:1000},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block',permissions:['camera']})
  const drivers=[{id:user.id,name:'Bruno'},{id:'22222222-2222-4222-8222-222222222222',name:'Jose'},{id:'33333333-3333-4333-8333-333333333333',name:'Rafael'}]
  const fixtureStreet=routeVariant==='letter'?'Rua Vinte e Dois de Abril':routeVariant==='neighborhood'?'Rua Aurora':'Rua Sintetica'
  const state={active,allowed,routesAllowed,calls:[],errors:[],permissionWrites:[],dispatchRows:[],volumeRequests:[],dispatchRequests:[],failVolume:false,postInsertFailures:0,readFailures:[],readOverrides:[],holdReading:false,pendingReads:[],readNumber:0,day:'',drivers}
  await context.addInitScript(({origin,user,token,logged})=>{
    if(location.origin!==origin||!logged)return
    localStorage.setItem('sb-hcpvmahmiqipghceylle-auth-token',JSON.stringify({access_token:token,refresh_token:'local-only',token_type:'bearer',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,user}))
  },{origin,user,token,logged})
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url())
    const json=(data,status=200,headers={})=>route.fulfill({status,headers,contentType:'application/json',body:JSON.stringify(data)})
    try{
      if(url.hostname==='hcpvmahmiqipghceylle.supabase.co'){
        state.calls.push(url.pathname)
        if(url.pathname==='/auth/v1/user')return json(user)
        if(url.pathname==='/auth/v1/logout')return json({})
        if(url.pathname==='/rest/v1/user_profiles')return json(url.searchParams.has('id')?{id:user.id,email:user.email,role,is_active:state.active}:[{id:'22222222-2222-4222-8222-222222222222',email:'convidado@example.invalid',role:'operador',is_active:true}])
        if(url.pathname==='/rest/v1/user_module_permissions'){
          if(request.method()==='POST'){
            assert.equal(role,'admin')
            state.permissionWrites.push(request.postDataJSON())
            return json(null)
          }
          return json(url.searchParams.has('user_id')?{user_id:user.id,label_reader_access:state.allowed,delivery_routes_manage:state.routesAllowed}:[])
        }
        if(url.pathname==='/rest/v1/delivery_route_base'||url.pathname==='/rest/v1/delivery_volumes'){
          assert.equal(logged&&state.active&&(role==='admin'||state.routesAllowed),true)
          assert.equal(request.method(),'GET')
          if(url.pathname.endsWith('delivery_route_base'))return json([])
          return json(Array.from({length:6},(_,index)=>({id:`route-${index}`,delivery_date:'2026-11-11',zone:'Norte',route:index===5?'R2':'R1',batch_number:1,driver_name:'Motorista sintetico',street:'Rua Sintetica',neighborhood:'Centro',city:'Suzano',postal_code:'08600-000',delivery_sequence:5-index,recipient_address:`Rua Sintetica, ${index+1}, Centro, Suzano, 08600-000`,address_confirmed:index!==5})))
        }
        throw new Error(`Unexpected Supabase request: ${url.pathname}`)
      }
      assert.equal(url.origin,origin,`External request: ${url.origin}`)
      if(url.pathname.startsWith('/api/')){
        state.calls.push(url.pathname)
        assert.equal(logged&&state.active&&(role==='admin'||state.allowed),true)
        assert.equal(request.headers().authorization,`Bearer ${token}`)
        if(url.pathname==='/api/bootstrap-admin'){
          assert.equal(role,'admin');assert.equal(request.method(),'POST');return json({ok:true})
        }
        if(url.pathname==='/api/label-dispatch'){
          if(dispatchUnavailable)return json({error:'Lista indisponivel. Confira a migracao dos motoristas.'},503)
          if(request.method()==='POST'){
            const body=request.postDataJSON()
            state.dispatchRequests.push(body)
            if(body.mode==='confirm-address'){const row=state.dispatchRows.find(row=>row.id===body.id);row.recipient_address=body.address;row.maps_address=body.mapsAddress;row.address_confirmed=true;return json({saved:true})}
            throw new Error('Unexpected dispatch action')
          }
          state.day=url.searchParams.get('day')
          return json({rows:dispatchScenario?state.dispatchRows.filter(row=>row.delivery_date===state.day):[],drivers:dispatchScenario?drivers:[{id:user.id,name:'Motorista sintetico'}],dispatcher:role==='admin',currentUserId:user.id,optimizationConfigured:false})
        }
        if(url.pathname==='/api/label-volume'){
          assert.equal(request.method(),'POST')
          const body=request.postDataJSON(),driver=drivers.find(driver=>driver.id===body.driverId)
          assert.ok(driver);assert.ok(body.packageAddress.includes(fixtureStreet))
          state.volumeRequests.push(body)
          if(state.failVolume)return json({error:'Falha sintetica ao salvar. Tente novamente.'},503)
          const duplicate=state.dispatchRows.some(row=>row.scan_key===body.scanKey)
          if(!duplicate)state.dispatchRows.push({id:crypto.randomUUID(),driver_id:body.driverId,driver_name:driver.name,capture_number:body.captureNumber??null,maps_address:body.mapsAddress??null,recipient_address:body.packageAddress,address_confirmed:body.addressConfirmed,delivery_sequence:1,created_at:new Date().toISOString(),scan_key:body.scanKey,delivery_date:state.day})
          if(state.postInsertFailures>0){state.postInsertFailures--;return json({error:'Resposta perdida depois de salvar',retryable:true},503)}
          return json({saved:true,duplicate,zone:'Norte',route:body.baseId==='base-2'&&routeVariant==='conflict'?'R2':'R1',batch:1,sequence:1})
        }
        if(url.pathname==='/api/label-routes'){
          const record={id:'base-1',street:fixtureStreet,neighborhood:routeVariant==='neighborhood'?'Jardim Horizonte II':'Centro',city:'Suzano',postalCode:'08600-000',zone:'Norte',route:'R1',deliverySequence:1}
          const records=dispatchScenario?[record]:[]
          if(dispatchScenario&&routeVariant!=='single')records.push({...record,id:'base-2',...(routeVariant==='neighborhood'?{street:'Avenida Horizonte',neighborhood:'Jardim Central',postalCode:'08600-001'}:routeVariant==='letter'?{street:'Rua E',neighborhood:'Outro Bairro',postalCode:'08600-001'}:{}),route:routeVariant==='duplicate'?'R1':'R2'})
          return json({records,summary:[],source:'Base sintetica',baseId:'local-only'})
        }
        if(url.pathname==='/api/label-read'){
          if(request.method()==='GET')return json({configured:true})
          const number=++state.readNumber
          if(state.holdReading)await new Promise(resolve=>state.pendingReads.push(resolve))
          const failure=state.readFailures.shift()
          if(failure)return json({error:failure.error,retryable:failure.retryable},failure.status,failure.retryAfter?{'Retry-After':failure.retryAfter}:{})
          return json({extraction:state.readOverrides.shift()??{recipient:{street:fixtureStreet,number:String(number),complement:null,neighborhood:routeVariant==='neighborhood'?'Jardim Horizonte II':'Centro',city:'Suzano',postalCode:'08600-000'},warnings:[],uncertainFields:[]}})
        }
        assert.equal(request.method(),'GET')
        throw new Error(`Unexpected API request: ${url.pathname}`)
      }
      return route.continue()
    }catch(error){state.errors.push(error.message);return route.abort()}
  })
  const page=await context.newPage()
  diagnostics.push({page,state})
  page.on('pageerror',error=>state.errors.push(error.message))
  await page.clock.install()
  await page.goto(`${origin}${path}`)
  return{context,page,state}
}
try{
  if(process.env.LABEL_READER_CASE!=='correction'){
  const anonymous=await fixture({logged:false})
  await anonymous.page.getByRole('button',{name:'Entrar no sistema',exact:true}).waitFor()
  assert.equal(await anonymous.page.locator('meta[name="viewport"]').getAttribute('content'),'width=device-width, initial-scale=1')
  assert.equal(anonymous.state.calls.length,0)
  await anonymous.page.screenshot({path:'tmp/label-reader/screenshots/login-mobile.png',fullPage:true})
  await anonymous.context.close()
  for(const mobile of[true,false]){
    const {context,page,state}=await fixture({mobile})
    await page.getByRole('heading',{name:'Leitor de etiquetas',exact:true}).waitFor()
    await page.getByRole('button',{name:'Abrir leitura cont\u00ednua sem pausa'}).waitFor()
    await page.waitForFunction(()=>!document.querySelector('.label-capture button.primary')?.disabled)
    assert.equal(await page.locator('.sidebar,aside,nav').count(),0)
    assert.ok(state.calls.includes('/api/label-routes'))
    assert.ok(state.calls.includes('/api/label-read'))
    const geometry=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}))
    assert.ok(geometry.scroll<=geometry.width+1,JSON.stringify(geometry))
    assert.equal(await page.locator('.label-reader > :last-child').getAttribute('class'),'label-dispatch')
    const order=await page.evaluate(()=>({photo:document.querySelector('.label-grid').getBoundingClientRect().bottom,result:document.querySelector('.label-route-details').getBoundingClientRect().bottom,dispatch:document.querySelector('.label-dispatch').getBoundingClientRect().top}))
    assert.ok(order.dispatch>=Math.max(order.photo,order.result),JSON.stringify(order))
    await page.screenshot({path:`tmp/label-reader/screenshots/reader-${mobile?'mobile':'desktop'}.png`,fullPage:true})
    state.allowed=false
    await page.clock.fastForward(15050)
    await page.getByRole('heading',{name:'Acesso restrito',exact:true}).waitFor()
    assert.equal(await page.getByLabel('Enviar foto',{exact:true}).count(),0)
    assert.equal(await page.getByRole('button',{name:'Abrir leitura cont\u00ednua sem pausa'}).count(),0)
    state.allowed=true
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')))
    await page.getByLabel('Enviar foto',{exact:true}).waitFor()
    state.active=false
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')))
    await page.getByRole('heading',{name:'Acesso restrito',exact:true}).waitFor()
    await page.getByRole('button',{name:'Sair da conta'}).click()
    await page.getByRole('button',{name:'Entrar no sistema',exact:true}).waitFor()
    assert.deepEqual(state.errors,[])
    await context.close()
  }
  for(const options of[{mobile:true,role:'operador'},{mobile:false,role:'admin'}]){
    const unavailable=await fixture({...options,dispatchScenario:true,dispatchUnavailable:true})
    const {page,state}=unavailable
    await page.getByRole('alert').filter({hasText:'Lista indisponivel. Confira a migracao dos motoristas.'}).waitFor()
    await page.getByRole('heading',{name:'Preparando leitura...',exact:true}).waitFor({state:'hidden'})
    const cameraButton=page.getByRole('button',{name:'Abrir leitura cont\u00ednua sem pausa',exact:true})
    assert.equal(await cameraButton.isEnabled(),true,'Dispatch failure must not block an authorized user camera')
    assert.equal(await page.getByLabel('Enviar foto',{exact:true}).isEnabled(),true)
    assert.equal(await page.getByLabel('Selecionar fotos em massa',{exact:true}).isEnabled(),true)
    await cameraButton.click()
    await page.waitForFunction(()=>{const video=document.querySelector('video');return video?.readyState>=2&&video.videoWidth>0})
    await page.screenshot({path:`tmp/label-reader/screenshots/camera-without-dispatch-${options.mobile?'mobile':'desktop'}.png`,fullPage:true})
    const saved=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/label-volume'&&request.method()==='POST')
    await page.getByRole('button',{name:'Capturar pacote #1',exact:true}).click()
    assert.equal((await saved).postDataJSON().driverId,user.id)
    await page.getByRole('button',{name:'Fechar c\u00e2mera',exact:true}).click()
    const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=640;canvas.height=400;canvas.getContext('2d').fillRect(0,0,640,400);return canvas.toDataURL('image/png').split(',')[1]})
    const photoSaved=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/label-volume'&&request.method()==='POST')
    await page.getByLabel('Enviar foto',{exact:true}).setInputFiles({name:'etiqueta-sintetica.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')})
    assert.equal((await photoSaved).postDataJSON().driverId,user.id)
    assert.deepEqual(state.errors,[])
    await unavailable.context.close()
  }
  for(const options of[{allowed:false},{active:false,allowed:true},{active:false,role:'admin'}]){
    const {context,page,state}=await fixture(options)
    await page.getByRole('heading',{name:'Acesso restrito',exact:true}).waitFor()
    assert.ok(!state.calls.some(path=>path.startsWith('/api/')))
    assert.deepEqual(state.errors,[])
    await context.close()
  }
  for(const path of['/','/documentos','/mensagens','/leitor-etiquetas','/financeiro']){
    const isolated=await fixture({path})
    await isolated.page.getByRole('heading',{name:'Leitor de etiquetas',exact:true}).waitFor()
    assert.equal(new URL(isolated.page.url()).pathname,'/bipar')
    assert.equal(await isolated.page.locator('aside,nav').count(),0)
    assert.deepEqual(isolated.state.errors,[])
    await isolated.context.close()
  }
  const unapproved=await fixture({allowed:false,path:'/documentos'})
  await unapproved.page.getByRole('heading',{name:'Acesso restrito',exact:true}).waitFor()
  assert.equal(await unapproved.page.locator('aside,nav').count(),0)
  assert.ok(!unapproved.state.calls.some(path=>path.startsWith('/api/')))
  await unapproved.context.close()
  const admin=await fixture({role:'admin',mobile:false})
  await admin.page.goto(`${origin}/configuracoes`)
  await admin.page.getByRole('button',{name:'Copiar link do leitor',exact:true}).waitFor()
  assert.equal(await admin.page.getByRole('link',{name:`${origin}/bipar`,exact:true}).getAttribute('href'),`${origin}/bipar`)
  await admin.page.getByRole('row').filter({hasText:'convidado@example.invalid'}).getByRole('button',{name:'Configurar',exact:true}).click()
  await admin.page.getByRole('combobox').selectOption({label:'Somente leitor de etiquetas'})
  assert.equal(await admin.page.getByRole('checkbox',{checked:true}).count(),1)
  assert.equal(await admin.page.getByRole('checkbox',{name:'Leitor de etiquetas',exact:true}).isChecked(),true)
  await admin.page.getByRole('button',{name:'Salvar permiss\u00f5es',exact:true}).click()
  await admin.page.getByText('Permiss\u00f5es salvas.',{exact:false}).waitFor()
  assert.equal(admin.state.permissionWrites.at(-1).label_reader_access,true)
  assert.equal(Object.entries(admin.state.permissionWrites.at(-1)).filter(([key,value])=>key!=='user_id'&&value).length,1)
  await admin.page.getByRole('combobox').selectOption({label:'Somente cadastros'})
  assert.equal(await admin.page.getByRole('checkbox',{name:'Leitor de etiquetas',exact:true}).isChecked(),false)
  await admin.page.getByRole('combobox').selectOption({label:'Sem acesso'})
  assert.equal(await admin.page.getByRole('checkbox',{checked:true}).count(),0)
  await admin.page.getByRole('combobox').selectOption({label:'Somente rotas'})
  assert.equal(await admin.page.getByRole('checkbox',{checked:true}).count(),1)
  assert.equal(await admin.page.getByRole('checkbox',{name:'Gerenciar rotas',exact:true}).isChecked(),true)
  await admin.page.getByRole('button',{name:'Salvar permiss\u00f5es',exact:true}).click()
  await admin.page.waitForFunction(()=>document.querySelector('.form-message')?.textContent.includes('Permiss\u00f5es salvas'))
  assert.equal(admin.state.permissionWrites.at(-1).delivery_routes_manage,true)
  assert.equal(admin.state.permissionWrites.at(-1).label_reader_access,false)
  assert.deepEqual(admin.state.errors,[])
  await admin.context.close()
  for(const mobile of [true,false]){
    const routes=await fixture({mobile,routesAllowed:true,allowed:false,path:'/rotas-entrega'})
    await routes.page.getByRole('heading',{name:'Base e pr\u00e9-rotas',exact:true}).waitFor()
    assert.equal(await routes.page.getByRole('button',{name:'Rotas de entrega',exact:true}).count(),1)
    assert.equal(await routes.page.getByRole('button',{name:'Leitor de etiquetas',exact:true}).count(),0)
    const links=await routes.page.locator('.route-maps-links a').evaluateAll(anchors=>anchors.map(anchor=>anchor.href))
    assert.equal(links.length,2)
    const stops=[]
    for(const link of links){const url=new URL(link);assert.equal(url.hostname,'www.google.com');assert.ok((url.searchParams.get('waypoints')?.split('|')??[]).length<=3);stops.push(...(url.searchParams.get('waypoints')?.split('|')??[]),url.searchParams.get('destination'))}
    assert.deepEqual(stops,[5,4,3,2,1].map(number=>`R. Sintetica, ${number}, Centro, Suzano, 08600-000`))
    assert.equal(new URL(links[1]).searchParams.get('origin'),stops[3])
    await routes.page.getByText('Confira o endereco completo de todas as paradas antes de exportar.',{exact:true}).waitFor()
    assert.equal(await routes.page.locator('.route-maps-links a').evaluateAll(links=>links.every(link=>link.scrollWidth<=link.clientWidth)),true)
    await routes.page.locator('.route-plans').screenshot({path:`tmp/label-reader/screenshots/route-maps-${mobile?'mobile':'desktop'}.png`})
    assert.deepEqual(routes.state.errors,[])
    routes.state.routesAllowed=false
    await routes.page.reload()
    await routes.page.getByRole('heading',{name:'Acesso restrito',exact:true}).waitFor()
    assert.equal(await routes.page.locator('.route-maps-links a').count(),0)
    await routes.context.close()
  }
  }
  for(const mobile of[true,false]){
    const manual=await fixture({role:'admin',mobile,dispatchScenario:true,routeVariant:'conflict'})
    const {page,state}=manual
    await page.getByLabel('Motorista das proximas leituras',{exact:true}).waitFor()
    await page.getByRole('button',{name:'Abrir leitura cont\u00ednua sem pausa',exact:true}).click()
    await page.waitForFunction(()=>{const video=document.querySelector('video');return video?.readyState>=2&&video.videoWidth>0})
    await page.getByRole('button',{name:'Capturar pacote #1',exact:true}).click()
    await page.getByText('Rota n\u00e3o definida \u2014 n\u00e3o salvo',{exact:true}).waitFor()
    assert.equal(state.volumeRequests.length,0,'An ambiguous route must never be confirmed automatically')
    await page.getByRole('link',{name:'Editar leitura #1',exact:true}).click()
    assert.equal(await page.locator('.label-correction').getAttribute('open'),'')
    await page.getByLabel('Rota da foto #1',{exact:true}).selectOption('base-2')
    await page.getByLabel('Motorista da foto #1',{exact:true}).selectOption(state.drivers[1].id)
    state.failVolume=true
    await page.getByRole('button',{name:'Salvar correcao',exact:true}).click()
    await page.getByRole('button',{name:'Repetir salvamento',exact:true}).waitFor()
    await page.waitForFunction(()=>document.querySelector('.label-correction [role="alert"]')?.textContent.includes('Falha sintetica'))
    const failed=state.volumeRequests.at(-1),readCount=state.readNumber
    assert.equal(failed.captureNumber,1);assert.equal(failed.baseId,'base-2');assert.equal(failed.driverId,state.drivers[1].id);assert.equal(failed.addressConfirmed,true)
    assert.equal(await page.getByLabel('Rota da foto #1',{exact:true}).isDisabled(),true)
    assert.equal(await page.getByLabel('Motorista da foto #1',{exact:true}).isDisabled(),true)
    await page.getByRole('button',{name:'Capturar pacote #2',exact:true}).click()
    await page.waitForFunction(()=>document.querySelectorAll('.camera-batch-item').length===2&&document.querySelector('.camera-batch-item .item-route-warning'))
    assert.equal(state.volumeRequests.length,1,'Next photo must continue without saving its ambiguous destination')
    state.failVolume=false;state.postInsertFailures=1
    await page.getByRole('button',{name:'Repetir salvamento',exact:true}).click()
    await page.getByText('Aguardando nova tentativa 1/2...',{exact:true}).waitFor()
    await page.clock.runFor(1100)
    await page.waitForFunction(()=>document.querySelector('.ld-totals strong')?.textContent==='1')
    assert.equal(state.readNumber,readCount+1,'Manual recovery must not repeat OCR')
    assert.equal(state.dispatchRows.length,1)
    for(const request of state.volumeRequests)assert.deepEqual(request,failed,'Retries must preserve the corrected address, route, driver, scan key and photo number')
    assert.equal(state.dispatchRows[0].capture_number,1)
    assert.equal(await page.getByLabel('Motorista das proximas leituras',{exact:true}).inputValue(),user.id)
    await page.getByLabel('Lista do motorista',{exact:true}).selectOption(state.drivers[1].id)
    const link=page.getByRole('link',{name:'Google Maps: trecho 1/1',exact:true})
    await link.waitFor()
    const url=new URL(await link.getAttribute('href'))
    assert.equal(url.searchParams.get('destination'),failed.mapsAddress)
    assert.equal(state.dispatchRequests.length,0,'A corrected complete address needs no separate confirm click')
    const download=page.waitForEvent('download');await page.getByRole('button',{name:'Excel',exact:true}).click()
    const file=await download,workbook=XLSX.read(await readFile(await file.path()),{type:'buffer'})
    const rows=XLSX.utils.sheet_to_json(workbook.Sheets.Pacotes)
    assert.equal(rows[0]['Numero da foto'],1);assert.equal(rows[0].Motorista,'Jose')
    await page.getByRole('link',{name:'Editar leitura #2',exact:true}).click()
    assert.equal(await page.locator('.label-correction-content').evaluateAll(elements=>elements.every(element=>element.scrollWidth<=element.clientWidth)),true)
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1))
    await page.locator('#label-dispatch').screenshot({path:`tmp/label-reader/screenshots/correction-${mobile?'mobile':'desktop'}.png`})
    assert.deepEqual(state.errors,[])
    await manual.context.close()
  }
  for(const scenario of['outside','uncertain','ocr-error']){
    const manual=await fixture({mobile:true,dispatchScenario:true})
    const {page,state}=manual
    await page.getByLabel('Motorista das proximas leituras',{exact:true}).waitFor()
    const reading={recipient:{street:'Rua Sintetica',number:null,complement:null,neighborhood:'Centro',city:'Suzano',postalCode:'08600-000'},warnings:['Numero nao identificado'],uncertainFields:['recipient.number']}
    if(scenario==='outside')Object.assign(reading.recipient,{street:'Rua Fora da Base',postalCode:'99999-999'})
    if(scenario==='uncertain')reading.uncertainFields.push('recipient.street')
    if(scenario==='ocr-error')state.readFailures.push({status:503,retryable:false,error:'OCR sintetico indisponivel'})
    else state.readOverrides.push(reading)
    await page.getByRole('button',{name:'Abrir leitura cont\u00ednua sem pausa',exact:true}).click()
    await page.waitForFunction(()=>{const video=document.querySelector('video');return video?.readyState>=2&&video.videoWidth>0})
    await page.getByRole('button',{name:'Capturar pacote #1',exact:true}).click()
    await page.getByRole('link',{name:'Editar leitura #1',exact:true}).click()
    assert.equal(state.volumeRequests.length,0)
    await page.getByRole('button',{name:'Salvar correcao',exact:true}).click()
    await page.getByRole('alert').filter({hasText:'Preencha rua, numero, cidade e CEP completo conforme a foto.'}).waitFor()
    assert.equal(state.volumeRequests.length,0,'Incomplete addresses must stay out of Maps')
    for(const[label,value]of[['Rua / Logradouro','Rua Sintetica'],['Numero','123'],['Cidade','Suzano'],['CEP','08600-000']])await page.getByLabel(`${label} da foto #1`,{exact:true}).fill(value)
    await page.getByLabel('Rota da foto #1',{exact:true}).selectOption('base-1')
    assert.equal(await page.getByLabel('Motorista da foto #1',{exact:true}).isDisabled(),true,'An operator cannot assign another driver')
    const readCount=state.readNumber
    await page.getByRole('button',{name:'Salvar correcao',exact:true}).click()
    await page.getByRole('link',{name:'Google Maps: trecho 1/1',exact:true}).waitFor()
    assert.equal(state.readNumber,readCount)
    assert.equal(state.volumeRequests.length,1)
    assert.equal(state.volumeRequests[0].driverId,user.id)
    assert.equal(state.volumeRequests[0].addressConfirmed,true)
    assert.equal(state.dispatchRequests.length,0)
    assert.deepEqual(state.errors,[])
    await manual.context.close()
  }
  if(process.env.LABEL_READER_CASE!=='correction'){
  for(const mobile of [true,false]){
  const ambiguous=await fixture({role:'admin',mobile,dispatchScenario:true,routeVariant:'conflict'})
  await ambiguous.page.getByLabel('Motorista das proximas leituras',{exact:true}).waitFor()
  await ambiguous.page.getByRole('button',{name:'Abrir leitura cont\u00ednua sem pausa',exact:true}).click()
  await ambiguous.page.waitForFunction(()=>{const video=document.querySelector('video');return video?.readyState>=2&&video.videoWidth>0})
  await ambiguous.page.getByRole('button',{name:'Capturar pacote #1',exact:true}).click()
  await ambiguous.page.getByText('Rota n\u00e3o definida \u2014 n\u00e3o salvo',{exact:true}).waitFor()
  assert.equal(ambiguous.state.dispatchRows.length,0)
  assert.equal(ambiguous.state.calls.includes('/api/label-volume'),false)
  assert.equal(await ambiguous.page.locator('.camera-batch-item button').count(),0)
  await ambiguous.page.screenshot({path:`tmp/label-reader/screenshots/unresolved-route-${mobile?'mobile':'desktop'}.png`,fullPage:true})
  assert.deepEqual(ambiguous.state.errors,[])
  await ambiguous.context.close()
  for(const routeVariant of ['neighborhood','letter']){
  const automatic=await fixture({role:'admin',mobile,dispatchScenario:true,routeVariant})
  await automatic.page.getByLabel('Motorista das proximas leituras',{exact:true}).waitFor()
  await automatic.page.getByRole('button',{name:'Abrir leitura cont\u00ednua sem pausa',exact:true}).click()
  await automatic.page.waitForFunction(()=>{const video=document.querySelector('video');return video?.readyState>=2&&video.videoWidth>0})
  automatic.state.holdReading=true
  const reading=automatic.page.waitForRequest(request=>new URL(request.url()).pathname==='/api/label-read'&&request.method()==='POST')
  await automatic.page.getByRole('button',{name:'Capturar pacote #1',exact:true}).click();await reading
  await automatic.page.getByLabel('Motorista das proximas leituras',{exact:true}).selectOption(automatic.state.drivers[2].id)
  automatic.state.holdReading=false;automatic.state.pendingReads.splice(0).forEach(resolve=>resolve())
  await automatic.page.waitForFunction(()=>document.querySelector('.camera-batch-item .item-route-result small')?.textContent.includes('Adicionado'))
  assert.equal(automatic.state.dispatchRows.length,1)
  assert.equal(automatic.state.volumeRequests[0].baseId,'base-1')
  assert.equal(automatic.state.volumeRequests[0].driverId,user.id)
  assert.equal(automatic.state.volumeRequests[0].addressConfirmed,true)
  assert.equal(await automatic.page.locator('.camera-batch-item button').count(),0)
  automatic.state.failVolume=true
  await automatic.page.getByRole('button',{name:'Capturar pacote #2',exact:true}).click()
  await automatic.page.getByText(/N\u00e3o salvo na pr\u00e9-rota: Falha sintetica/).waitFor()
  assert.equal(automatic.state.dispatchRows.length,1)
  automatic.state.failVolume=false
  await automatic.page.getByRole('button',{name:'Capturar pacote #3',exact:true}).click()
  await automatic.page.waitForFunction(()=>document.querySelector('.ld-totals strong')?.textContent==='2')
  assert.equal(automatic.state.volumeRequests.length,3)
  assert.equal(new Set(automatic.state.volumeRequests.map(request=>request.scanKey)).size,3)
  assert.equal(await automatic.page.locator('.camera-batch-item button').count(),0)
  assert.equal(await automatic.page.locator('.camera-batch-item').evaluateAll(items=>items.every(item=>item.scrollWidth<=item.clientWidth)),true)
  await automatic.page.screenshot({path:`tmp/label-reader/screenshots/${routeVariant==='letter'?'letter':'automatic'}-route-${mobile?'mobile':'desktop'}.png`,fullPage:true})
  assert.deepEqual(automatic.state.errors,[])
  await automatic.context.close()
  }
  }
  for(const mobile of[true,false]){
    const recovery=await fixture({role:'admin',mobile,dispatchScenario:true})
    const {page,state}=recovery
    await page.getByLabel('Motorista das proximas leituras',{exact:true}).waitFor()
    assert.equal(await page.getByLabel('Lista do motorista',{exact:true}).inputValue(),user.id)
    assert.equal(await page.getByRole('button',{name:'Google Maps',exact:true}).isDisabled(),true)
    await page.getByRole('link',{name:'Google Maps e exportacao',exact:true}).click()
    assert.ok(await page.locator('#label-dispatch').evaluate(element=>{const box=element.getBoundingClientRect();return box.top>=-1&&box.top<window.innerHeight}))
    await page.getByRole('button',{name:'Abrir leitura cont\u00ednua sem pausa',exact:true}).click()
    await page.waitForFunction(()=>{const video=document.querySelector('video');return video?.readyState>=2&&video.videoWidth>0})
    const count=async total=>page.waitForFunction(total=>document.querySelector('.ld-totals strong')?.textContent===String(total),total)
    state.readFailures.push({status:429,retryable:true,retryAfter:'2',error:'Limite sintetico'})
    state.readOverrides.push({recipient:{street:'Rua Sintetica',number:'1',complement:'Casa dos fundos apto 9 bloco B',neighborhood:'Centro',city:'Suzano - SP',postalCode:'08600-000'},warnings:[],uncertainFields:[]})
    state.postInsertFailures=1
    await page.getByRole('button',{name:'Capturar pacote #1',exact:true}).click()
    await page.getByText('Aguardando nova tentativa 1/2...',{exact:true}).waitFor()
    const savedAttempt=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/label-volume'&&request.method()==='POST')
    await page.clock.runFor(2100)
    await savedAttempt
    await page.getByText('Aguardando nova tentativa 1/2...',{exact:true}).waitFor()
    await page.clock.runFor(1100)
    await count(1)
    assert.equal(state.readNumber,2)
    assert.equal(state.volumeRequests.length,2)
    assert.equal(state.volumeRequests[0].scanKey,state.volumeRequests[1].scanKey)
    assert.equal(state.volumeRequests[0].captureNumber,1)
    assert.equal(state.volumeRequests[1].captureNumber,1)
    assert.equal(state.dispatchRows.length,1)
    assert.ok(state.dispatchRows[0].recipient_address.includes('Casa dos fundos apto 9 bloco B'))
    assert.equal(state.dispatchRows[0].maps_address,'R. Sintetica, 1, Centro, Suzano - SP, 08600-000')
    state.readFailures.push({status:503,retryable:false,error:'Configuracao da leitura precisa do administrador'})
    await page.getByRole('button',{name:'Capturar pacote #2',exact:true}).click()
    await page.getByText('Configuracao da leitura precisa do administrador',{exact:true}).waitFor()
    const permanentReadCount=state.readNumber
    await page.clock.runFor(5000)
    assert.equal(state.readNumber,permanentReadCount)
    state.failVolume=true
    await page.getByRole('button',{name:'Capturar pacote #3',exact:true}).click()
    await page.getByText(/N\u00e3o salvo na pr\u00e9-rota: Falha sintetica/).waitFor()
    const failedWrite=state.volumeRequests.at(-1),readBeforeRetry=state.readNumber
    assert.equal(await page.locator('.camera-batch-item.batch-item-erro').count(),2)
    await page.getByText('Total: 3 pacotes \u00b7 1 salvos \u00b7 0 em andamento \u00b7 2 nao salvos',{exact:true}).waitFor()
    await page.getByLabel('Motorista das proximas leituras',{exact:true}).selectOption(state.drivers[1].id)
    state.failVolume=false
    await page.getByRole('button',{name:'Reprocessar falhas (2)',exact:true}).click()
    await count(3)
    assert.equal(state.readNumber,readBeforeRetry+1,'A save-only retry must reuse the OCR result')
    const sameCapture=state.volumeRequests.filter(request=>request.scanKey===failedWrite.scanKey)
    assert.equal(sameCapture.length,2)
    assert.deepEqual(sameCapture[0],sameCapture[1])
    assert.ok(state.dispatchRows.every(row=>row.driver_id===user.id))
    await page.getByLabel('Motorista das proximas leituras',{exact:true}).selectOption(user.id)
    for(const[start,end]of[[4,18],[19,30],[31,45],[46,50]]){
      state.holdReading=true
      for(let number=start;number<start+3;number++){
        const reading=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/label-read'&&request.method()==='POST')
        await page.getByRole('button',{name:`Capturar pacote #${number}`,exact:true}).click()
        await reading
      }
      for(let number=start+3;number<=end;number++)await page.getByRole('button',{name:`Capturar pacote #${number}`,exact:true}).click()
      await page.waitForFunction(()=>document.querySelectorAll('.camera-batch-item .tag-reading').length===3)
      assert.equal(state.pendingReads.length,3,'Only three camera reads in flight')
      assert.equal(await page.getByRole('button',{name:`Capturar pacote #${end+1}`,exact:true}).isEnabled(),true)
      state.holdReading=false;state.pendingReads.splice(0).forEach(resolve=>resolve())
      await count(end)
    }
    await page.getByText('Total: 50 pacotes \u00b7 50 salvos \u00b7 0 em andamento \u00b7 0 nao salvos',{exact:true}).waitFor()
    assert.equal(state.dispatchRows.length,50)
    assert.equal(new Set(state.volumeRequests.map(request=>request.scanKey)).size,50)
    const captureNumbers=new Map(state.dispatchRows.map(row=>[row.scan_key,row.capture_number]))
    assert.deepEqual([...captureNumbers.values()].sort((first,second)=>first-second),Array.from({length:50},(_,index)=>index+1))
    for(const request of state.volumeRequests)assert.equal(request.captureNumber,captureNumbers.get(request.scanKey))
    assert.equal(await page.locator('.camera-batch-item button').count(),0)
    await page.getByRole('link',{name:'Exportar rota no Google Maps',exact:true}).click()
    assert.ok(await page.locator('#label-dispatch').evaluate(element=>{const box=element.getBoundingClientRect();return box.top>=-1&&box.top<window.innerHeight}))
    const links=await page.locator('.ld-links a').evaluateAll(elements=>elements.map(element=>element.href))
    assert.equal(links.length,13)
    const exported=[]
    for(const link of links){const url=new URL(link);exported.push(...(url.searchParams.get('waypoints')?.split('|')??[]),url.searchParams.get('destination'))}
    assert.deepEqual(exported,state.dispatchRows.map(row=>row.maps_address))
    await page.getByLabel('Paradas por trecho',{exact:true}).selectOption('10')
    const appLinks=await page.locator('.ld-links a').evaluateAll(elements=>elements.map(element=>element.href)),appAddresses=[]
    assert.equal(appLinks.length,5)
    let previous=null
    for(const link of appLinks){const url=new URL(link),waypoints=url.searchParams.get('waypoints')?.split('|')??[];assert.ok(waypoints.length<=9);assert.ok(link.length<=2048);assert.equal(url.searchParams.get('dir_action'),'navigate');assert.equal(url.searchParams.get('origin'),previous);appAddresses.push(...waypoints,url.searchParams.get('destination'));previous=url.searchParams.get('destination')}
    assert.deepEqual(appAddresses,state.dispatchRows.map(row=>row.maps_address))
    assert.equal(state.dispatchRequests.length,0,'Fifty complete certain OCR addresses must open Maps without per-package confirmation')
    state.dispatchRows.forEach(row=>{row.delivery_sequence=51-row.capture_number})
    state.dispatchRows.sort((first,second)=>first.delivery_sequence-second.delivery_sequence)
    await page.getByRole('button',{name:'Atualizar expedicao',exact:true}).click()
    await page.waitForFunction(()=>document.querySelector('.ld-table tbody tr')?.children[2]?.textContent==='#50')
    const numberedDownload=page.waitForEvent('download')
    await page.getByRole('button',{name:'Excel',exact:true}).click()
    const numberedFile=await numberedDownload,numberedWorkbook=XLSX.read(await readFile(await numberedFile.path()),{type:'buffer'})
    const numberedRows=XLSX.utils.sheet_to_json(numberedWorkbook.Sheets.Pacotes)
    assert.deepEqual(numberedRows.map(row=>row['Numero da foto']),Array.from({length:50},(_,index)=>50-index))
    assert.deepEqual(numberedRows.map(row=>row.Ordem),Array.from({length:50},(_,index)=>index+1))
    assert.deepEqual(numberedRows.map(row=>row.Leitura),state.dispatchRows.map(row=>row.id))
    assert.ok(numberedRows.find(row=>row['Numero da foto']===1).Endereco.includes('Casa dos fundos apto 9 bloco B'),'The full complement must remain in Excel')
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1))
    await page.locator('#label-dispatch').screenshot({path:`tmp/label-reader/screenshots/recovery-maps-${mobile?'mobile':'desktop'}.png`})
    await page.locator('.camera-batch-section').screenshot({path:`tmp/label-reader/screenshots/recovery-queue-${mobile?'mobile':'desktop'}.png`})
    const readCount=state.readNumber
    await page.reload()
    await count(50)
    assert.equal(await page.locator('.ld-table tbody tr').first().locator('td').nth(2).innerText(),'#50')
    const firstRow=state.dispatchRows.find(row=>row.capture_number===1)
    assert.equal(await page.getByLabel(`Endereco para Maps ${firstRow.id}`,{exact:true}).inputValue(),firstRow.maps_address)
    assert.equal(state.readNumber,readCount)
    assert.deepEqual(state.errors,[])
    await recovery.context.close()
  }
  const expedition=await fixture({role:'admin',mobile:true,dispatchScenario:true,routeVariant:'duplicate'})
  const {page,state}=expedition
  await page.getByLabel('Motorista das proximas leituras',{exact:true}).waitFor()
  const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=640;canvas.height=400;canvas.getContext('2d').fillRect(0,0,640,400);return canvas.toDataURL('image/png').split(',')[1]})
  const photo={name:'etiqueta-sintetica.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')}
  const count=async total=>{await page.waitForFunction(total=>document.querySelector('.ld-totals strong')?.textContent===String(total),total)}
  state.holdReading=true
  const firstRead=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/label-read'&&request.method()==='POST')
  await page.getByLabel('Enviar foto',{exact:true}).setInputFiles(photo);await firstRead
  await page.getByLabel('Motorista das proximas leituras',{exact:true}).selectOption(driversId(expedition,1))
  state.holdReading=false;state.pendingReads.splice(0).forEach(resolve=>resolve())
  await count(1);assert.equal(state.dispatchRows[0].driver_id,user.id)
  for(const driver of[state.drivers[1],state.drivers[2],state.drivers[1],state.drivers[2]]){
    await page.getByLabel('Motorista das proximas leituras',{exact:true}).selectOption(driver.id)
    const total=state.dispatchRows.length+1
    await page.getByLabel('Enviar foto',{exact:true}).setInputFiles(photo);await count(total)
  }
  assert.deepEqual(state.dispatchRows.map(row=>row.driver_name),['Bruno','Jose','Rafael','Jose','Rafael'])
  await page.getByLabel('Lista do motorista',{exact:true}).selectOption(state.drivers[1].id)
  assert.equal(await page.locator('.ld-table tbody tr').count(),2)
  await page.getByRole('link',{name:'Google Maps: trecho 1/1',exact:true}).waitFor()
  const row=state.dispatchRows.find(row=>row.driver_name==='Jose')
  await page.getByLabel(`Endereco do pacote ${row.id}`,{exact:true}).fill('Rua Sintetica, 123, Centro, Suzano SP')
  assert.equal(await page.getByRole('link',{name:'Google Maps: trecho 1/1',exact:true}).count(),0)
  await page.getByRole('button',{name:`Confirmar endereco ${row.id}`,exact:true}).click()
  await page.getByRole('link',{name:'Google Maps: trecho 1/1',exact:true}).waitFor()
  const fullAddress=row.recipient_address
  await page.getByLabel(`Endereco para Maps ${row.id}`,{exact:true}).fill('R. Sintetica, 123, Suzano SP')
  assert.equal(await page.getByRole('link',{name:'Google Maps: trecho 1/1',exact:true}).count(),0)
  await page.getByRole('button',{name:`Confirmar endereco ${row.id}`,exact:true}).click()
  await page.getByRole('link',{name:'Google Maps: trecho 1/1',exact:true}).waitFor()
  assert.equal(row.recipient_address,fullAddress,'Editing only Maps must not alter the full package address')
  assert.equal(row.maps_address,'R. Sintetica, 123, Suzano SP')
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Excel',exact:true}).click()
  const excel=await download,workbook=XLSX.read(await readFile(await excel.path()),{type:'buffer'})
  assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets.Pacotes).length,2)
  assert.ok(XLSX.utils.sheet_to_json(workbook.Sheets.Pacotes).every(row=>(row['Numero da foto']??'')===''))
  await page.getByLabel('Motorista das proximas leituras',{exact:true}).selectOption(state.drivers[2].id)
  await page.getByLabel('Selecionar fotos em massa',{exact:true}).setInputFiles([photo,{...photo,name:'segunda.png'}])
  await count(7)
  assert.equal(state.dispatchRows.filter(row=>row.driver_name==='Rafael').length,4)
  await page.getByLabel('Dia das leituras',{exact:true}).fill('2026-01-01');await count(0)
  const capturedDay=state.dispatchRows[0].delivery_date
  await page.getByLabel('Dia das leituras',{exact:true}).fill(capturedDay);await count(7)
  await page.getByLabel(`Endereco do pacote ${row.id}`,{exact:true}).fill('Rua Sintetica, 999, Suzano SP')
  await page.getByLabel('Motorista das proximas leituras',{exact:true}).selectOption(state.drivers[0].id)
  await page.getByRole('button',{name:'Abrir leitura contínua sem pausa',exact:true}).click()
  await page.waitForFunction(()=>{const video=document.querySelector('video');return video?.readyState>=2&&video.videoWidth>0})
  state.holdReading=true
  const cameraFirst=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/label-read'&&request.method()==='POST')
  await page.getByRole('button',{name:'Capturar pacote #1',exact:true}).click();await cameraFirst
  await page.getByLabel('Motorista das proximas leituras',{exact:true}).selectOption(state.drivers[2].id)
  const cameraSecond=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/label-read'&&request.method()==='POST')
  await page.getByRole('button',{name:'Capturar pacote #2',exact:true}).click();await cameraSecond
  state.holdReading=false;state.pendingReads.splice(0).forEach(resolve=>resolve())
  await count(9)
  assert.equal(await page.locator('.camera-batch-item').count(),2)
  assert.equal(await page.getByText('2 endere\u00e7os poss\u00edveis \u2014 conferir',{exact:true}).count(),0)
  assert.deepEqual(state.dispatchRows.slice(-2).map(row=>row.driver_id).sort(),[state.drivers[0].id,state.drivers[2].id].sort())
  assert.equal(await page.getByLabel(`Endereco do pacote ${row.id}`,{exact:true}).inputValue(),'Rua Sintetica, 999, Suzano SP')
  await page.getByRole('button',{name:'Excel',exact:true}).click()
  await page.getByRole('alert').filter({hasText:'Confirme os enderecos alterados antes de exportar.'}).waitFor()
  await page.getByRole('button',{name:`Confirmar endereco ${row.id}`,exact:true}).click()
  await page.getByRole('button',{name:'Excel',exact:true}).waitFor({state:'visible'})
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1))
  await page.screenshot({path:'tmp/label-reader/screenshots/dispatch-mobile.png',fullPage:true})
  await page.setViewportSize({width:1440,height:1000})
  await page.screenshot({path:'tmp/label-reader/screenshots/dispatch-desktop.png',fullPage:true})
  assert.deepEqual(state.errors,[])
  await expedition.context.close()
  }
  console.log(process.env.LABEL_READER_CASE==='correction'?'PASS: manual correction mobile/desktop, ambiguous and outside-base routes, uncertain and unavailable OCR, driver permissions, frozen retries without duplicate writes, Maps and Excel; no real writes.':'PASS: real App isolation/revocation, manual corrections, alternating drivers, 50-camera recovery on mobile/desktop without duplicate writes or per-package address confirmation, bounded retries, save-only replay, 4/10-stop Maps modes with all 50 destinations, separate clean Maps address, full complements in Excel, 9 photo/batch/camera packages and retained drafts; no real writes.')
}catch(error){
  for(const{page,state}of diagnostics.filter(({page})=>!page.isClosed())){
    console.error(JSON.stringify(state),await page.locator('body').innerText())
    await page.screenshot({path:'tmp/label-reader/screenshots/failure.png',fullPage:true})
  }
  throw error
}finally{await browser.close()}

function driversId(fixture,index){return fixture.state.drivers[index].id}