import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import * as XLSX from 'xlsx'

const origin=process.env.MAIS_ENVIOS_BASE_URL||'http://127.0.0.1:5175'
const output='tmp/mais-envios-tests'
await mkdir(`${output}/screenshots`,{recursive:true})
const user={id:'11111111-1111-4111-8111-111111111111',email:'financeiro@example.invalid',aud:'authenticated'}
const jwt=['local',Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'test'].join('.')
const market='Id;Cliente;Telefone;E-mail;Atendente;Codigo de Rastreio;Marketplace;Data de Criacao\n001;Pessoa;0011;teste@example.invalid;Smart A;AB123456789BR;Loja;02/10/2026 10:00:00\n002;;;;Smart A;AB123456789BR;Loja;01/10/2026 10:00:00\n003;;;;Smart A;12345;Loja;03/10/2026 10:00:00\n004;;;;Smart A;BR123456789012A;Loja;04/10/2026 10:00:00'
const posting='Etiqueta;Status;Remetente;Destinatario;Data Criacao;Data Postagem;Peso;Servico;Valor\nP1;Entregue;Origem;Destino;2026-10-01;2026-10-02;1;Servico;100,00\np1;Entregue;Origem;Destino;2026-10-01;2026-10-02;1;Servico;100,00\nP2;Etiqueta expirada;Origem;Destino;2026-10-01;2026-10-02;1;Servico;50,00\nP3;Em transito;Origem;Destino;2026-10-01;2026-10-02;1;Servico;10,00'
const browser=await chromium.launch({channel:'msedge',headless:true})
const diagnostics=[]
async function fixture({mobile=false,manage=true,active=true,source=[]}={}){
  const context=await browser.newContext({viewport:{width:mobile?390:1440,height:mobile?844:1000},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'})
  const state={records:structuredClone(source),logs:[],writes:[],sends:[],errors:[],loseInsert:false,registrations:[{id:'33333333-3333-4333-8333-333333333333',smart:'Smart A',email:'a@example.invalid',responsavel:'Pessoa A'},{id:'44444444-4444-4444-8444-444444444444',smart:'Smart B',email:'b@example.invalid',responsavel:'Pessoa B'}]}
  await context.addInitScript(({origin,user,jwt})=>{if(location.origin===origin)localStorage.setItem('sb-hcpvmahmiqipghceylle-auth-token',JSON.stringify({access_token:jwt,refresh_token:'local-only',token_type:'bearer',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,user}))},{origin,user,jwt})
  await context.routeWebSocket('**/*',socket=>{if(new URL(socket.url()).origin===origin.replace('http:','ws:'))socket.connectToServer();else socket.close()})
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url())
    const json=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)})
    try{
      if(url.hostname==='hcpvmahmiqipghceylle.supabase.co'){
        if(url.pathname==='/auth/v1/user')return json(user)
        assert.ok(url.pathname.startsWith('/rest/v1/'))
        const table=url.pathname.split('/').at(-1)
        if(table==='user_profiles')return json({...user,role:'operador',is_active:active})
        if(table==='user_module_permissions')return json({user_id:user.id,financeiro_view:true,financeiro_manage:manage,cadastros_view:manage})
        assert.ok(active,'Inactive user fetched finance data')
        if(table==='mais_envios_registrations')return json(state.registrations)
        if(table==='mais_envios_closing_mail')return json(state.logs)
        assert.equal(table,'mais_envios_closings','No other business tables may be read or changed')
        if(request.method()==='POST'){
          assert.ok(manage)
          const record=request.postDataJSON()
          assert.equal(record.created_by,user.id)
          assert.ok(!record.rows.some(row=>row.validity==='pending'))
          state.writes.push(record)
          state.records.push({...record,created_at:'2026-11-09T12:00:00Z',rows:record.rows.map(row=>Object.fromEntries(Object.entries(row).reverse()))})
          if(state.loseInsert){state.loseInsert=false;return route.abort('failed')}
          return json(state.records.at(-1),201)
        }
        assert.equal(request.method(),'GET')
        const id=url.searchParams.get('id')?.replace(/^eq\./,'')
        if(id)return json(state.records.find(row=>row.id===id)??null)
        const offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||100)
        return json(state.records.slice(offset,offset+limit))
      }
      assert.equal(url.origin,origin,`External request ${url.origin}`)
      if(url.pathname==='/api/financial/mais-envios'){
        assert.ok(active&&manage);assert.equal(request.headers().authorization,`Bearer ${jwt}`)
        const payload=request.postDataJSON(),closing=state.records.find(row=>row.id===payload.closingId)
        assert.ok(closing);assert.equal(payload.smart,'Smart A')
        state.sends.push(payload)
        state.logs.push({smart_key:'smart a',status:'aceito'})
        return json({status:'aceito',duplicate:false})
      }
      assert.ok(!url.pathname.startsWith('/api/'),`Unmocked API ${url.pathname}`)
      return route.continue()
    }catch(error){state.errors.push(error.message);return route.abort()}
  })
  const page=await context.newPage();diagnostics.push({page,state});page.on('pageerror',error=>state.errors.push(error.message))
  return{page,context,state}
}
const download=async(page,button)=>{
  const waiting=page.waitForEvent('download');await button.click();const file=await waiting,path=`${output}/${file.suggestedFilename()}`;await file.saveAs(path);return readFile(path)
}
try{
  const {page,context,state}=await fixture()
  await page.goto(`${origin}/financeiro/mais-envios/pagamento-total`)
  const sidebar=page.locator('aside nav')
  await sidebar.getByRole('button',{name:'Fechamento',exact:true}).waitFor()
  assert.equal(await sidebar.getByRole('button',{name:'Finanças',exact:true}).count(),0)
  assert.equal(await sidebar.getByRole('button',{name:'Financeiro',exact:true}).count(),0)
  assert.equal(await sidebar.getByRole('button',{name:'Mais Envios',exact:true}).getAttribute('aria-expanded'),'true')
  await sidebar.getByRole('button',{name:'iMile',exact:true}).click()
  await sidebar.getByRole('group',{name:'Fechamento iMile',exact:true}).getByRole('button',{name:'Importar base',exact:true}).waitFor()
  assert.equal(await sidebar.getByRole('group',{name:'Fechamento Mais Envios',exact:true}).count(),0)
  const company=await sidebar.getByRole('button',{name:'iMile',exact:true}).boundingBox(),entry=await sidebar.getByRole('group',{name:'Fechamento iMile',exact:true}).getByRole('button',{name:'Pagamento Total',exact:true}).boundingBox()
  assert.ok(entry.x>company.x+10,'Company links must be visibly indented')
  await sidebar.getByRole('button',{name:'J&T Express',exact:true}).click()
  assert.equal(await sidebar.getByRole('group',{name:'Fechamento J&T Express',exact:true}).getByRole('button',{name:'Pagamento total',exact:true}).isDisabled(),true)
  await sidebar.getByRole('button',{name:'Mais Envios',exact:true}).click()
  await sidebar.getByRole('group',{name:'Fechamento Mais Envios',exact:true}).getByRole('button',{name:'Pagamento total',exact:true}).click()
  await sidebar.getByRole('group',{name:'Fechamento Mais Envios',exact:true}).getByRole('button',{name:'Pagamento detalhes',exact:true}).click()
  await page.waitForURL(url=>url.pathname==='/financeiro/mais-envios/pagamento-detalhes')
  await sidebar.getByRole('button',{name:'iMile',exact:true}).click()
  await page.goBack()
  await sidebar.locator('button[aria-label="Mais Envios"][aria-expanded="true"]').waitFor()
  await page.reload()
  await sidebar.locator('button[aria-label="Mais Envios"][aria-expanded="true"]').waitFor()
  await page.screenshot({path:`${output}/screenshots/closing-menu-desktop.png`,fullPage:true})
  await page.getByRole('button',{name:'Novo fechamento',exact:true}).click()
  await page.getByLabel('Periodo Mais Envios',{exact:true}).fill('Outubro/2026')
  await page.getByLabel('Smart das postagens',{exact:true}).fill('Smart B')
  await page.getByLabel('Importar CSVs Mais Envios',{exact:true}).setInputFiles([{name:'marketplace.csv',mimeType:'text/csv',buffer:Buffer.from(market)},{name:'postagens.csv',mimeType:'text/csv',buffer:Buffer.from(posting)}])
  await page.getByRole('status').filter({hasText:'7 linhas importadas. 1 etiquetas'}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Confirmar fechamento',exact:true}).isDisabled(),true)
  assert.equal(state.writes.length,0)
  await page.getByRole('navigation',{name:'Financeiro Mais Envios',exact:true}).getByRole('link',{name:'Pagamento detalhes',exact:true}).click()
  const manual=page.locator('tbody tr').filter({has:page.locator('input[value="12345"]')})
  await manual.locator('select').selectOption('valid')
  const correction=page.locator('tbody tr').filter({has:page.locator('input[value="BR123456789012A"]')})
  const correctionLabel=await correction.locator('input[aria-label^="Codigo"]').getAttribute('aria-label')
  await correction.getByRole('textbox').last().fill('99999')
  await page.getByLabel(correctionLabel.replace('Codigo ','Validacao '),{exact:true}).selectOption('invalid')
  await page.getByLabel('Tipo',{exact:true}).selectOption('posting')
  await page.locator('tbody tr').filter({hasText:'Em transito'}).locator('select').selectOption('invalid')
  assert.equal(await page.getByRole('button',{name:'Confirmar fechamento',exact:true}).isEnabled(),true)
  const excel=await download(page,page.getByRole('button',{name:'Excel',exact:true}))
  const workbook=XLSX.read(excel,{type:'buffer'})
  assert.deepEqual(workbook.SheetNames,['Marketplace','Postagens','Resumo Final'])
  assert.equal(workbook.Sheets.Marketplace.B2.v,'001');assert.equal(workbook.Sheets.Marketplace.B2.t,'s')
  await page.getByRole('navigation',{name:'Financeiro Mais Envios',exact:true}).getByRole('link',{name:'Pagamento total',exact:true}).click()
  await page.getByRole('row').filter({hasText:'Smart B'}).getByText('R$\u00a085,00',{exact:true}).first().waitFor()
  const pdf=await download(page,page.getByRole('button',{name:'PDF Smart A',exact:true}))
  assert.ok(pdf.subarray(0,5).equals(Buffer.from('%PDF-')))
  const pdfCheck=await page.evaluate(async bytes=>{
    const pdfjs=await import('/node_modules/pdfjs-dist/build/pdf.mjs');pdfjs.GlobalWorkerOptions.workerSrc='/node_modules/pdfjs-dist/build/pdf.worker.mjs'
    const pdf=await pdfjs.getDocument({data:new Uint8Array(bytes),useSystemFonts:true}).promise
    const page=await pdf.getPage(1),text=(await page.getTextContent()).items.map(item=>item.str).join(' ')
    const canvas=document.createElement('canvas'),viewport=page.getViewport({scale:1.3});canvas.id='me-pdf-test';canvas.width=viewport.width;canvas.height=viewport.height;canvas.style.cssText='display:block;position:relative;z-index:9999;background:white'
    document.body.prepend(canvas);await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise
    const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data
    let yellow=0,ink=0;for(let index=0;index<pixels.length;index+=4){if(pixels[index]>220&&pixels[index+1]>200&&pixels[index+2]<80)yellow++;if(pixels[index]<100&&pixels[index+1]<100&&pixels[index+2]<100)ink++}
    return{text,pages:pdf.numPages,width:viewport.width,height:viewport.height,yellow,ink}
  },[...pdf])
  assert.ok(pdfCheck.text.indexOf('POSTAGENS PAGAS')<pdfCheck.text.indexOf('OBJETOS MARKETPLACE'))
  assert.ok(pdfCheck.text.includes('Smart A'));assert.ok(pdfCheck.text.includes('+Envios paga para Smart'))
  assert.ok(pdfCheck.width<pdfCheck.height&&pdfCheck.yellow>1000&&pdfCheck.ink>1000,JSON.stringify(pdfCheck))
  await page.locator('#me-pdf-test').screenshot({path:`${output}/screenshots/pdf-smart-a.png`});await page.locator('#me-pdf-test').evaluate(element=>element.remove())
  const zip=await download(page,page.getByRole('button',{name:'PDFs (ZIP)',exact:true}));assert.equal(zip.subarray(0,2).toString(),'PK')
  const eml=await download(page,page.getByRole('button',{name:'Rascunho Smart A',exact:true}));assert.ok(eml.toString().includes('X-Unsent: 1'));assert.ok(eml.toString().includes('To: a@example.invalid'));assert.ok(eml.toString().includes('application/pdf'));assert.equal(state.sends.length,0)
  state.loseInsert=true;page.once('dialog',dialog=>dialog.accept())
  await page.getByRole('button',{name:'Confirmar fechamento',exact:true}).click()
  await page.getByRole('status').filter({hasText:'Fechamento confirmado.'}).waitFor()
  assert.equal(state.records.length,1);assert.equal(state.writes.length,1)
  const stored=structuredClone(state.records[0])
  assert.equal(stored.rows.find(row=>row.originalCode==='BR123456789012A').code,'99999')
  assert.equal(stored.contacts.find(row=>row.smart==='Smart A').email,'a@example.invalid')
  state.registrations[0].email='alterado@example.invalid'
  await page.screenshot({path:`${output}/screenshots/summary-desktop.png`,fullPage:true})
  await page.reload();await page.getByLabel('Fechamento salvo',{exact:true}).selectOption(stored.id)
  await page.getByText('Contatos e e-mail do fechamento',{exact:true}).click()
  assert.equal(await page.getByLabel('E-mail Smart A',{exact:true}).inputValue(),'a@example.invalid')
  assert.equal(await page.getByLabel('E-mail Smart A',{exact:true}).isDisabled(),true)
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Enviar e-mail Smart A',exact:true}).click()
  await page.getByRole('status').filter({hasText:'E-mail aceito pelo provedor'}).waitFor()
  assert.equal(state.sends.length,1);assert.equal(await page.getByRole('button',{name:'Enviar e-mail Smart A',exact:true}).isDisabled(),true)
  await page.getByRole('button',{name:'Novo fechamento',exact:true}).click();await page.getByLabel('Periodo Mais Envios',{exact:true}).fill('Novembro/2026')
  await page.getByLabel('Importar CSVs Mais Envios',{exact:true}).setInputFiles({name:'repeat.csv',mimeType:'text/csv',buffer:Buffer.from(market.split('\n').slice(0,2).join('\n'))})
  await page.getByRole('navigation',{name:'Financeiro Mais Envios',exact:true}).getByRole('link',{name:'Pagamento detalhes',exact:true}).click()
  await page.getByLabel('Validacao',{exact:true}).selectOption('duplicate')
  await page.locator('tbody select[aria-label^="Validacao"]').first().waitFor()
  assert.equal(await page.locator('tbody select[aria-label^="Validacao"]').first().inputValue(),'duplicate')
  assert.deepEqual(state.records[0],stored)
  assert.deepEqual(state.errors,[])
  await context.close()
  for(const mobile of[true,false]){
    const viewer=await fixture({mobile,manage:false,source:[stored]})
    await viewer.page.goto(`${origin}/financeiro/mais-envios/pagamento-total`);await viewer.page.getByLabel('Fechamento salvo',{exact:true}).selectOption(stored.id)
    await viewer.page.getByRole('button',{name:'PDF Smart A',exact:true}).waitFor()
    assert.equal(await viewer.page.getByRole('button',{name:'Novo fechamento',exact:true}).count(),0)
    assert.equal(await viewer.page.getByRole('button',{name:'Enviar e-mail Smart A',exact:true}).count(),0)
    const geometry=await viewer.page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}))
    assert.ok(geometry.scroll<=geometry.width+1,JSON.stringify(geometry))
    await viewer.page.screenshot({path:`${output}/screenshots/viewer-${mobile?'mobile':'desktop'}.png`,fullPage:true})
    if(!mobile){
      await viewer.page.setViewportSize({width:800,height:900})
      assert.equal(await viewer.page.locator('.nav-closing-companies').evaluate(element=>getComputedStyle(element).display),'grid')
      assert.equal(await viewer.page.locator('.nav-closing-companies > .nav-company').first().evaluate(element=>getComputedStyle(element).display),'flex')
      await viewer.page.locator('.app > aside').screenshot({path:`${output}/screenshots/closing-menu-800.png`})
    }
    assert.deepEqual(viewer.state.errors,[]);assert.equal(viewer.state.writes.length,0);await viewer.context.close()
  }
  const inactive=await fixture({active:false})
  await inactive.page.goto(`${origin}/financeiro/mais-envios/pagamento-total`);await inactive.page.getByRole('heading',{name:'Acesso restrito',exact:true}).waitFor()
  assert.deepEqual(inactive.state.errors,[]);await inactive.context.close()
  console.log('PASS real App Mais Envios: CSV/manual review/code correction, per-Smart summary, literal XLSX, rendered A4/yellow PDF, ZIP/EML, lost-response recovery, immutable contacts, send-once UI, cross-period duplicate, readonly desktop/mobile and inactive identity; no real writes or emails.')
}catch(error){
  for(const{page,state}of diagnostics.filter(({page})=>!page.isClosed())){console.error(JSON.stringify({errors:state.errors,writes:state.writes.length,sends:state.sends.length}),await page.locator('body').innerText());await page.screenshot({path:`output/screenshots/failure.png`.replace('output',output),fullPage:true})}
  throw error
}finally{await browser.close()}