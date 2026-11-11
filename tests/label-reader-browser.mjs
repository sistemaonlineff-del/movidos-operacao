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
async function fixture({logged=true,active=true,allowed=true,mobile=true,role='operador',path='/bipar',dispatchScenario=false,dispatchUnavailable=false,routeVariant='single'}={}) {
  const context=await browser.newContext({viewport:{width:mobile?390:1440,height:mobile?844:1000},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block',permissions:['camera']})
  const drivers=[{id:user.id,name:'Bruno'},{id:'22222222-2222-4222-8222-222222222222',name:'Jose'},{id:'33333333-3333-4333-8333-333333333333',name:'Rafael'}]
  const state={active,allowed,calls:[],errors:[],permissionWrites:[],dispatchRows:[],holdReading:false,pendingReads:[],readNumber:0,day:'',drivers}
  await context.addInitScript(({origin,user,token,logged})=>{
    if(location.origin!==origin||!logged)return
    localStorage.setItem('sb-hcpvmahmiqipghceylle-auth-token',JSON.stringify({access_token:token,refresh_token:'local-only',token_type:'bearer',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,user}))
  },{origin,user,token,logged})
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url())
    const json=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)})
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
          return json(url.searchParams.has('user_id')?{user_id:user.id,label_reader_access:state.allowed}:[])
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
            if(body.mode==='confirm-address'){const row=state.dispatchRows.find(row=>row.id===body.id);row.recipient_address=body.address;row.address_confirmed=true;return json({saved:true})}
            throw new Error('Unexpected dispatch action')
          }
          state.day=url.searchParams.get('day')
          return json({rows:dispatchScenario?state.dispatchRows.filter(row=>row.delivery_date===state.day):[],drivers:dispatchScenario?drivers:[{id:user.id,name:'Motorista sintetico'}],dispatcher:role==='admin',currentUserId:user.id,optimizationConfigured:false})
        }
        if(url.pathname==='/api/label-volume'){
          assert.equal(request.method(),'POST')
          const body=request.postDataJSON(),driver=drivers.find(driver=>driver.id===body.driverId)
          assert.ok(driver);assert.ok(body.packageAddress.includes('Rua Sintetica'))
          if(!state.dispatchRows.some(row=>row.scan_key===body.scanKey))state.dispatchRows.push({id:crypto.randomUUID(),driver_id:body.driverId,driver_name:driver.name,recipient_address:body.packageAddress,address_confirmed:body.addressConfirmed,delivery_sequence:1,created_at:new Date().toISOString(),scan_key:body.scanKey,delivery_date:state.day})
          return json({saved:true,zone:'Norte',route:'R1',batch:1,sequence:1})
        }
        if(url.pathname==='/api/label-routes'){
          const record={id:'base-1',street:'Rua Sintetica',neighborhood:'Centro',city:'Suzano',postalCode:'08600-000',zone:'Norte',route:'R1',deliverySequence:1}
          const records=dispatchScenario?[record]:[]
          if(dispatchScenario&&routeVariant!=='single')records.push({...record,id:'base-2',route:routeVariant==='conflict'?'R2':'R1'})
          return json({records,summary:[],source:'Base sintetica',baseId:'local-only'})
        }
        if(url.pathname==='/api/label-read'){
          if(request.method()==='GET')return json({configured:true})
          const number=++state.readNumber
          if(state.holdReading)await new Promise(resolve=>state.pendingReads.push(resolve))
          return json({extraction:{recipient:{street:'Rua Sintetica',number:String(number),complement:null,neighborhood:'Centro',city:'Suzano',postalCode:'08600-000'},warnings:[],uncertainFields:[]}})
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
  assert.deepEqual(admin.state.errors,[])
  await admin.context.close()
  const ambiguous=await fixture({dispatchScenario:true,routeVariant:'conflict'})
  await ambiguous.page.getByLabel('Motorista das proximas leituras',{exact:true}).waitFor()
  await ambiguous.page.getByRole('button',{name:'Abrir leitura cont\u00ednua sem pausa',exact:true}).click()
  await ambiguous.page.waitForFunction(()=>{const video=document.querySelector('video');return video?.readyState>=2&&video.videoWidth>0})
  await ambiguous.page.getByRole('button',{name:'Capturar pacote #1',exact:true}).click()
  await ambiguous.page.getByText('2 endere\u00e7os poss\u00edveis \u2014 conferir',{exact:true}).waitFor()
  assert.equal(ambiguous.state.dispatchRows.length,0)
  assert.equal(ambiguous.state.calls.includes('/api/label-volume'),false)
  await ambiguous.page.screenshot({path:'tmp/label-reader/screenshots/conflicting-addresses-mobile.png',fullPage:true})
  assert.deepEqual(ambiguous.state.errors,[])
  await ambiguous.context.close()
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
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Excel',exact:true}).click()
  const excel=await download,workbook=XLSX.read(await readFile(await excel.path()),{type:'buffer'})
  assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets.Pacotes).length,2)
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
  console.log('PASS: real App isolation/revocation, alternating drivers, 9 saved photo/batch/continuous-camera packages, in-flight snapshots, per-day totals, retained address drafts, Maps and Excel; no real writes.')
}catch(error){
  for(const{page,state}of diagnostics.filter(({page})=>!page.isClosed())){
    console.error(JSON.stringify(state),await page.locator('body').innerText())
    await page.screenshot({path:'tmp/label-reader/screenshots/failure.png',fullPage:true})
  }
  throw error
}finally{await browser.close()}

function driversId(fixture,index){return fixture.state.drivers[index].id}