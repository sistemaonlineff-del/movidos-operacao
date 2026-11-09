import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const origin=process.env.LABEL_BASE_URL||'http://127.0.0.1:5174'
const user={id:'11111111-1111-4111-8111-111111111111',email:'motorista@example.invalid',aud:'authenticated'}
const token=['local',Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'test'].join('.')
const browser=await chromium.launch({channel:'msedge',headless:true})
const diagnostics=[]
await mkdir('tmp/label-reader/screenshots',{recursive:true})
async function fixture({logged=true,active=true,allowed=true,mobile=true,role='operador'}={}) {
  const context=await browser.newContext({viewport:{width:mobile?390:1440,height:mobile?844:1000},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'})
  const state={active,allowed,calls:[],errors:[],permissionWrites:[]}
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
        assert.equal(request.method(),'GET')
        if(url.pathname==='/api/label-routes')return json({records:[],summary:[],source:'Base sintetica',baseId:'local-only'})
        if(url.pathname==='/api/label-read')return json({configured:true})
        throw new Error(`Unexpected API request: ${url.pathname}`)
      }
      return route.continue()
    }catch(error){state.errors.push(error.message);return route.abort()}
  })
  const page=await context.newPage()
  diagnostics.push({page,state})
  page.on('pageerror',error=>state.errors.push(error.message))
  await page.clock.install()
  await page.goto(`${origin}/bipar`)
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
  for(const options of[{allowed:false},{active:false,allowed:true},{active:false,role:'admin'}]){
    const {context,page,state}=await fixture(options)
    await page.getByRole('heading',{name:'Acesso restrito',exact:true}).waitFor()
    assert.ok(!state.calls.some(path=>path.startsWith('/api/')))
    assert.deepEqual(state.errors,[])
    await context.close()
  }
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
  console.log('PASS: real App /bipar, anonymous login, mobile/desktop isolation, revocation/regrant, inactive users, logout; synthetic identity and no production writes.')
}catch(error){
  for(const{page,state}of diagnostics.filter(({page})=>!page.isClosed())){
    console.error(JSON.stringify(state),await page.locator('body').innerText())
    await page.screenshot({path:'tmp/label-reader/screenshots/failure.png',fullPage:true})
  }
  throw error
}finally{await browser.close()}