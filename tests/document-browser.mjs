import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import * as XLSX from 'xlsx'

await mkdir('tmp/browser-tests', { recursive: true })
await build({ entryPoints: ['src/closingSpreadsheet.ts'], outfile: 'tmp/browser-tests/closing.cjs', bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const { createClosingTemplate } = await import(pathToFileURL(`${process.cwd()}/tmp/browser-tests/closing.cjs`).href)
const schema = await readFile('supabase/schema.sql', 'utf8')
const allowedDropStatuses = [...schema.match(/status text not null default 'INTERESSADO' check \(status in \(([^\n]+)\)\)/)[1].matchAll(/'([^']+)'/g)].map(match => match[1])
const partnerSchema = await readFile('supabase/migrations/20260914130000_restore_drop_partners.sql', 'utf8')
const allowedDropPartners = [...partnerSchema.match(/partner in \(([^)]+)\)/)[1].matchAll(/'([^']+)'/g)].map(match => match[1])
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'local-test@example.com', aud: 'authenticated' }
const jwt = ['header', Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'test-signature'].join('.')
const partner = 'IMILE DELIVERY BRAZIL LTDA'
const tables = {
  user_profiles: [{ ...user, full_name: 'Teste local', role: 'admin', is_active: true }],
  user_module_permissions: [{ user_id: user.id }],
  drops: [{ id: 'drop1', name: 'DROP TESTE', responsible: 'Eduardo', partner, status: 'ATIVO', is_active: true, signed_at: '2026-09-01', terminated_at: null, termination_reason: null, monthly_value: .13, municipality: 'Suzano', state: 'SP' }],
  financial_periods: [{ id: 'p1', label: 'SETEMBRO', partner: 'Eduardo', financial_view_id: 'v1', reference_cnpj: null, net_amount: 1000, payment_date: '2026-09-15', is_active: true }],
  financial_views: [{ id: 'v1', title: 'SETEMBRO', is_active: true, notes: '{}' }],
  financial_payment_history: [],
  financial_drop_items: [{ id: 'item1', financial_period_id: 'p1', drop_name_snapshot: 'DROP TESTE', quantity_packages: 100, unit_value: .13, reimbursement: 0, is_active: true, registration_snapshot: { version: 1, dropId: 'drop1', responsible: 'Eduardo', pix: '', email: 'eduardo@example.test', document: '', pixHolderName: '' } }],
  loss_events: [],
  email_templates: [{ key: 'financial_closing', subject: 'MODELO FINANCEIRO PRIVADO', body: 'CONTEUDO FINANCEIRO PRIVADO' }, { key: 'ready-message-initial', subject: 'Mensagem inicial', body: 'Atendimento publico' }],
  app_notes: [{ key: 'ready_messages_draft', content: 'Rascunho anterior' }],
  email_logs: [],
  drop_documents: [],
}
const photoBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1cAAAAASUVORK5CYII=', 'base64')
const storagePaths = new Set()
let serviceTemplatePath = ''
let terminationTemplatePath = ''
let rejectTemplateDownload = false
let rejectTemplateLoad = false
let invoiceRequests = []
let invoiceSubmissions = []
const invoiceActions = []
const writes = []
const failures = []
let rejectDropWrite = false
let unchangedDropWrite = false
let holdDropWrite = false
const pendingDropWrites = []
let rejectLossWrite = false
let rejectClosingWrite = false
let missingLogisticsColumn = false
let missingRegistrationSnapshot = false
let rejectClosingItems = false
let rejectPaymentWrite = false
let holdPaymentWrite = false
let losePaymentResponse = false
const pendingPaymentWrites = []
const paymentRequests = []
let holdLossWrite = false
const pendingLossWrites = []
const lossRequests = []
let loseLossResponseId = ''
let activeReads = 0
let maximumReads = 0
let completedReads = 0
let allowReads = false
const pendingReads = []
const mailRequests = []
let mailConfigured = true
let mailPilotRecipient = null
let mailUncertain = false
let mailTestBlocked = false
let mailRetryUncertain = false
const testRetryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const labelResult = { extraction: { recipient: { street: 'Rua das Flores', neighborhood: 'Centro', city: 'Suzano', postalCode: '08600-000' }, warnings: [], uncertainFields: [] } }
await context.addInitScript(({ user, jwt }) => {
  localStorage.setItem('sb-hcpvmahmiqipghceylle-auth-token', JSON.stringify({ access_token: jwt, refresh_token: 'local-only', token_type: 'bearer', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, user }))
}, { user, jwt })
const mockRequests = async route => {
  const request = route.request()
  const url = new URL(request.url())
  const json = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) })
  if (url.hostname.endsWith('supabase.co')) {
    if (url.pathname === '/auth/v1/user') return json(user)
    if (url.pathname.startsWith('/storage/v1/')) {
      const path = decodeURIComponent(url.pathname.split('/movidos-documents/')[1] || '')
      if (url.pathname.startsWith('/storage/v1/object/sign/') && request.method() === 'POST') return json({ signedURL: `/object/sign/movidos-documents/${path}?token=test-only` })
      if (request.method() === 'POST') { storagePaths.add(path); return json({ Key: `movidos-documents/${path}` }) }
      assert.ok(storagePaths.has(path), `Stored object must exist: ${path}`)
      if (path.startsWith('contract-templates/') && path.endsWith('.docx')) {
        if (rejectTemplateDownload) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Modelo indisponivel no teste' }) })
        return route.fulfill({ contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body: await readFile(path.includes('/termination/') ? 'public/templates/modelo-distrato-sociedade.docx' : 'public/templates/modelo-contrato-prestacao-servico.docx') })
      }
      return route.fulfill({ contentType: path.endsWith('.png') ? 'image/png' : 'application/pdf', body: path.endsWith('.png') ? photoBytes : Buffer.from('%PDF-1.7\nTest attachment\n%%EOF') })
    }
    if (!url.pathname.startsWith('/rest/v1/')) return json([])
    const table = url.pathname.split('/').pop()
    if(url.pathname.includes('/rpc/')&&table==='clear_route_postal_codes'){
      const payload=request.postDataJSON();writes.push({table,payload})
      const selected=tables.delivery_route_base.filter(row=>payload.route_ids.includes(row.id)&&row.is_active!==false&&row.postal_code)
      selected.forEach(row=>{row.postal_code=null})
      return json(selected.length)
    }
    if(url.pathname.includes('/rpc/')&&table==='change_financial_view'){
      const payload=request.postDataJSON();writes.push({table,payload})
      const view=tables.financial_views.find(row=>row.id===payload.view_id)
      assert.equal(view.title,payload.expected_title)
      const periods=tables.financial_periods.filter(row=>row.financial_view_id===view.id),ids=new Set(periods.map(row=>row.id))
      if(payload.action==='rename'){
        view.title=payload.new_title;periods.forEach(row=>{row.label=payload.new_title})
        for(const tableName of ['financial_payment_history','loss_events'])tables[tableName].filter(row=>ids.has(row.financial_period_id)).forEach(row=>{row.period_label=payload.new_title})
      }else{
        view.is_active=false;periods.forEach(row=>{row.is_active=false})
        for(const tableName of ['financial_drop_items','financial_payment_history','loss_events'])tables[tableName].filter(row=>ids.has(row.financial_period_id)).forEach(row=>{row.is_active=false})
      }
      return json(null)
    }
    const source = tables[table] ?? []
    const filtered = source.filter(row => [...url.searchParams].every(([field, value]) => {
      if (value.startsWith('eq.')) return String(row[field]) === value.slice(3)
      if (value === 'is.null') return row[field] == null
      if (value.startsWith('in.(')) return value.slice(4, -1).split(',').includes(String(row[field]))
      if (value.startsWith('like.')) return String(row[field]).startsWith(value.slice(5).replace(/%$/, ''))
      return true
    }))
    let output = filtered
    if (table === 'financial_payment_history' && ['POST', 'PATCH'].includes(request.method())) {
      const payload = request.postDataJSON()
      paymentRequests.push({ method: request.method(), payload })
      if (rejectPaymentWrite) return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: '42501', message: 'Permissão negada no teste de pagamento.' }) })
      if (request.method() === 'POST' && source.some(row => row.id === payload.id)) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: '23505', message: 'Duplicate primary key' }) })
      if (holdPaymentWrite) await new Promise(resolve => pendingPaymentWrites.push(resolve))
    }
    if (table === 'financial_drop_items' && request.method() === 'POST' && rejectClosingItems) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: '22003', message: 'Valor fora do limite no teste.' }) })
    if (table === 'financial_drop_items' && request.method() === 'GET' && missingRegistrationSnapshot && url.searchParams.get('select')?.includes('registration_snapshot')) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: '42703', message: 'column financial_drop_items.registration_snapshot does not exist' }) })
    if (table === 'financial_periods' && request.method() === 'GET' && missingLogisticsColumn && url.searchParams.get('select')?.includes('logistics_partner')) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: '42703', message: 'column financial_periods.logistics_partner does not exist' }) })
    if (table === 'financial_views' && request.method() === 'POST' && rejectClosingWrite) return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: '42501', message: 'Permissão negada no teste de importação.' }) })
    if (table === 'loss_events' && ['POST', 'PATCH'].includes(request.method())) {
      const payload = request.postDataJSON()
      lossRequests.push({ method: request.method(), payload })
      if (rejectLossWrite || (tables.user_profiles[0].role !== 'admin' && !tables.user_module_permissions[0].financeiro_manage)) return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: '42501', message: 'Permissão negada no teste de extravios.' }) })
      if (request.method() === 'POST' && source.some(row => row.id === payload.id)) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: '23505', message: 'Duplicate primary key' }) })
      if (holdLossWrite) await new Promise(resolve => pendingLossWrites.push(resolve))
    }
    if (table === 'drops' && ['POST', 'PATCH'].includes(request.method())) {
      const payload = request.postDataJSON()
      if (payload.status != null) assert.ok(allowedDropStatuses.includes(payload.status), `Status rejected by SQL constraint: ${payload.status}`)
      if (payload.partner != null) assert.ok(allowedDropPartners.includes(payload.partner), `Partner rejected by SQL constraint: ${payload.partner}`)
      if (rejectDropWrite) return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: '42501', message: 'Permissão negada no teste.' }) })
      if (unchangedDropWrite) return json(filtered[0] ?? null)
      if (holdDropWrite) await new Promise(resolve => pendingDropWrites.push(resolve))
    }
    if (request.method() === 'POST') {
      const payload = request.postDataJSON()
      writes.push({ table, payload })
      const records = Array.isArray(payload) ? payload : [payload]
      output = records.map(record => {
        const existing = source.find(row => record.key && row.key === record.key)
        if (existing) { Object.assign(existing, record); return existing }
        const inserted = { id: `${table}-${source.length + 1}`, is_active: true, ...record }
        source.push(inserted)
        return inserted
      })
      tables[table] = source
      if (table === 'financial_payment_history' && losePaymentResponse) return route.abort('failed')
    } else if (request.method() === 'PATCH') {
      const payload = request.postDataJSON()
      writes.push({ table, payload })
      output.forEach(row => Object.assign(row, payload))
      if (table === 'loss_events' && output.some(row => row.id === loseLossResponseId)) return route.abort('failed')
    }
    return json(request.headers().accept?.includes('application/vnd.pgrst.object+json') ? output[0] ?? null : output)
  }
  if (url.origin === 'http://127.0.0.1:5173') {
    if (url.pathname === '/api/financial/send-closing') {
      if (!mailConfigured) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Conta remetente não configurada no teste.' }) })
      if (request.method() === 'GET') return json({ configured: true, from: 'sender@example.com', testRecipient: mailPilotRecipient })
      const payload = request.postDataJSON()
      assert.ok(request.headers().authorization.startsWith('Bearer '))
      if (payload.mode === 'verify') {
        assert.deepEqual(payload, { mode: 'verify' })
        return json({ status: 'verified', message: 'Conexão e autenticação SMTP verificadas. Nenhum e-mail foi enviado. Isso não confirma a entrega da tentativa anterior nem libera seu reenvio.' })
      }
      if (payload.mode === 'test') {
        mailRequests.push(payload)
        if (payload.retryOf) {
          assert.deepEqual(payload, { mode: 'test', retryOf: testRetryId, reconciled: true })
          if (mailRetryUncertain) return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ status: 'incerto', error: 'Repetição sem confirmação; confira as caixas.' }) })
          return json({ status: 'aceito', duplicate: false })
        }
        assert.deepEqual(payload, { mode: 'test' })
        if (mailTestBlocked) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ status: 'incerto', error: 'Teste anterior sem confirmação.', retryOf: testRetryId }) })
        return json({ status: 'aceito', duplicate: false })
      }
      assert.ok(Buffer.from(payload.pdf, 'base64').toString('latin1').startsWith('%PDF-'))
      assert.equal(payload.period, 'SETEMBRO')
      assert.equal(payload.partner, partner)
      assert.equal(payload.dropId, 'drop1')
      assert.equal(payload.to, undefined)
      mailRequests.push(payload)
      if (mailUncertain) return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ status: 'incerto', error: 'Confira a caixa remetente.' }) })
      return json({ status: 'aceito', duplicate: false })
    }
    if (url.pathname === '/api/contract-templates') {
      if (request.method() === 'GET' && rejectTemplateLoad) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Modelo indisponivel no teste' }) })
      if (request.method() === 'POST') {
        assert.equal(tables.user_profiles[0].role, 'admin')
        const payload=request.postDataJSON()
        if(Object.hasOwn(payload,'serviceTemplatePath'))serviceTemplatePath = payload.serviceTemplatePath
        if(Object.hasOwn(payload,'terminationTemplatePath'))terminationTemplatePath = payload.terminationTemplatePath
      }
      return json({ serviceTemplatePath,terminationTemplatePath })
    }
    if (url.pathname === '/api/financial/invoices') {
      const token=request.headers()['x-invoice-token']
      if(request.method()==='POST'&&request.postDataJSON().mode==='submit-public'){
        const payload=request.postDataJSON();invoiceActions.push(payload)
        assert.equal(request.headers().authorization,undefined)
        invoiceSubmissions.push({id:payload.clientUploadId,drop_name:payload.dropName,responsible:payload.responsible,period_label:payload.period,partner:payload.partner,reference_cnpj:payload.referenceCnpj,file_name:payload.fileName,status:'pending',created_at:'2026-10-18T12:00:00Z'})
        return json({status:'pending',protocol:payload.clientUploadId})
      }
      if(token){
        if(token!=='a'.repeat(64))return route.fulfill({status:410,contentType:'application/json',body:JSON.stringify({error:'Link expirado ou revogado.'})})
        if(request.method()==='POST'){
          const payload=request.postDataJSON();invoiceActions.push(payload)
          assert.equal(payload.mode,'upload');assert.equal(payload.fileName,'nf-teste.pdf')
          invoiceRequests[0].financial_invoice_files.push({id:'file1',file_name:'nf-teste.pdf',status:'received',received_at:'2026-10-12T10:00:00Z'})
          return json({status:'received'})
        }
        return json({drop:'DROP TESTE',period:'SETEMBRO',partner,referenceCnpj:'MOVIDOS',expiresAt:'2100-01-01',files:invoiceRequests[0]?.financial_invoice_files??[]})
      }
      assert.ok(request.headers().authorization.startsWith('Bearer '))
      if(request.method()==='GET')return json({requests:invoiceRequests,submissions:invoiceSubmissions})
      const payload=request.postDataJSON();invoiceActions.push(payload)
      if(payload.mode==='create'){
        invoiceRequests=[{id:'req1',financial_period_id:payload.periodId,drop_id:payload.dropId,drop_name:'DROP TESTE',period_label:'SETEMBRO',partner,reference_cnpj:'MOVIDOS',expires_at:'2100-01-01',revoked_at:null,financial_invoice_files:invoiceRequests[0]?.financial_invoice_files??[]}]
        return json({token:'a'.repeat(64),requestId:'req1'})
      }
      if(payload.mode==='revoke'){invoiceRequests[0].revoked_at='2026-10-12T12:00:00Z';return json({revoked:true})}
      if(payload.mode==='reconcile'){invoiceRequests[0].financial_invoice_files.find(file=>file.id===payload.fileId).status='received';return json({status:'received'})}
      if(payload.mode==='intake-approve'){Object.assign(invoiceSubmissions.find(file=>file.id===payload.intakeId),{status:'approved',financial_period_id:payload.periodId,drop_id:payload.dropId});return json({status:'approved'})}
      throw new Error(`Unexpected invoice action ${payload.mode}`)
    }
    if (url.pathname === '/api/label-routes') return json({ source: 'Teste local', summary: [], records: [{ id: 'route1', street: 'Rua das Flores', neighborhood: 'Centro', city: 'Suzano', postalCode: '08600-000', zone: 'Centro', route: '1', deliverySequence: 1, mapsUrl: '', routeUrl: '', sourceSheet: 'Teste', sourceRow: 1 }] })
    if (url.pathname === '/api/label-read') {
      if (request.method() === 'GET') return json({ configured: true })
      activeReads++
      maximumReads = Math.max(maximumReads, activeReads)
      const finish = async () => { activeReads--; completedReads++; await json(labelResult) }
      if (allowReads) return finish()
      pendingReads.push(finish)
      return
    }
    if (url.pathname === '/api/label-volume') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Falha simulada de gravacao' }) })
    return route.continue()
  }
  return route.abort()
}
await context.route('**/*', mockRequests)
const page = await context.newPage()
page.on('pageerror', error => failures.push(error.message))
page.setDefaultTimeout(15000)
try {
  if (process.env.CAMERA_ONLY !== '1') {
  await page.goto('http://127.0.0.1:5173/financeiro/notas-fiscais')
  await page.getByRole('cell',{name:'DROP TESTE',exact:true}).waitFor()
  await page.getByRole('cell',{name:'Pendente',exact:true}).waitFor()
  {
    const periodsBefore=structuredClone(tables.financial_periods),itemsBefore=structuredClone(tables.financial_drop_items)
    for(const [id,label] of [['nf-old','35. 1Q DE SETEMBRO'],['nf-new','36. 2Q DE SETEMBRO']]){
      tables.financial_periods.push({...periodsBefore[0],id,label})
      tables.financial_drop_items.push({...itemsBefore[0],id:`${id}-item`,financial_period_id:id})
    }
    await page.reload();await page.getByRole('cell',{name:'36. 2Q DE SETEMBRO',exact:true}).waitFor()
    assert.deepEqual(await page.getByLabel('Quinzena',{exact:true}).locator('option').allTextContents(),['Todas','36. 2Q DE SETEMBRO','35. 1Q DE SETEMBRO','SETEMBRO'])
    assert.equal(await page.locator('.invoice-table tbody tr').first().locator('td').first().textContent(),'36. 2Q DE SETEMBRO')
    tables.financial_periods=periodsBefore;tables.financial_drop_items=itemsBefore
    await page.reload();await page.getByRole('cell',{name:'DROP TESTE',exact:true}).waitFor()
  }
  const commonLink=await page.getByRole('region',{name:'Link de envio',exact:true}).getByRole('textbox').inputValue()
  assert.equal(commonLink,'http://127.0.0.1:5173/enviar-nf')
  assert.equal(await page.getByRole('button',{name:/^(Gerar link|Renovar link|Revogar)$/}).count(),0)
  await page.goto(commonLink)
  await page.getByLabel('DROP',{exact:true}).fill('DROP TESTE')
  await page.getByLabel('Responsável',{exact:true}).fill('Eduardo')
  await page.getByLabel('Quinzena',{exact:true}).fill('SETEMBRO')
  await page.getByLabel('Parceiro',{exact:true}).selectOption(partner)
  await page.getByLabel('CNPJ de referência',{exact:true}).selectOption('MOVIDOS')
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
    await page.setViewportSize(viewport)
    await page.screenshot({path:`tmp/browser-tests/invoice-shared-form-${viewport.width}.png`,fullPage:true})
  }
  await page.setViewportSize({width:1440,height:900})
  await page.getByLabel('Nota fiscal (PDF ou XML, até 3 MB)',{exact:true}).setInputFiles({name:'nf-comum.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7\nNF local\n%%EOF')})
  await page.getByRole('button',{name:'Enviar nota fiscal',exact:true}).click()
  await page.getByRole('status').filter({hasText:'Arquivo recebido para conferência.'}).waitFor()
  assert.equal(await page.getByRole('heading',{name:/Notas recebidas/}).count(),0)
  await page.goto('http://127.0.0.1:5173/financeiro/notas-fiscais')
  await page.getByRole('cell',{name:'Pendente',exact:true}).waitFor()
  await page.getByLabel('Pagamento para nf-comum.pdf',{exact:true}).selectOption('p1|drop1')
  await page.screenshot({path:'tmp/browser-tests/invoice-shared-review.png',fullPage:true})
  page.once('dialog',dialog=>dialog.accept())
  await page.getByRole('button',{name:'Confirmar recebimento',exact:true}).click()
  await page.getByRole('cell',{name:'Recebida',exact:true}).waitFor()
  assert.equal(invoiceSubmissions[0].financial_period_id,'p1');assert.equal(invoiceSubmissions[0].drop_id,'drop1')
  invoiceRequests=[{id:'req1',financial_period_id:'p1',drop_id:'drop1',drop_name:'DROP TESTE',period_label:'SETEMBRO',partner,reference_cnpj:'MOVIDOS',expires_at:'2100-01-01',revoked_at:null,financial_invoice_files:[]}]
  await page.goto(commonLink+'#token='+'a'.repeat(64))
  await page.getByRole('heading',{name:'DROP TESTE',exact:true}).waitFor()
  await page.getByLabel('Nota fiscal (PDF ou XML, até 3 MB)',{exact:true}).setInputFiles({name:'nf-teste.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7\nNF local\n%%EOF')})
  await page.getByRole('button',{name:'Enviar nota fiscal',exact:true}).click()
  await page.getByRole('status').filter({hasText:'Nota fiscal recebida e salva.'}).waitFor()
  await page.getByRole('heading',{name:'Notas recebidas (1)',exact:true}).waitFor()
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
    await page.setViewportSize(viewport)
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
    await page.screenshot({path:`tmp/browser-tests/invoice-upload-${viewport.width}.png`,fullPage:true})
  }
  await page.goto('http://127.0.0.1:5173/financeiro/notas-fiscais')
  await page.getByRole('cell',{name:'Recebida',exact:true}).waitFor()
  await page.getByLabel('Recebimento',{exact:true}).selectOption('pending')
  await page.getByRole('cell',{name:'Nenhum DROP neste filtro.',exact:true}).waitFor()
  await page.getByLabel('Recebimento',{exact:true}).selectOption('received')
  await page.getByRole('button',{name:'nf-teste.pdf',exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Revogar',exact:true}).count(),0)
  assert.equal(invoiceRequests[0].financial_invoice_files.length,1)
  invoiceRequests[0].financial_invoice_files.push({id:'unconfirmed-file',file_name:'nf-sem-confirmacao.pdf',status:'uploading',received_at:null})
  await page.reload()
  await page.getByRole('button',{name:'Conferir armazenamento',exact:true}).click()
  await page.getByRole('status').filter({hasText:'Arquivo conferido e recebimento confirmado.'}).waitFor()
  await page.getByRole('button',{name:'nf-sem-confirmacao.pdf',exact:true}).waitFor()
  const invoiceItems=tables.financial_drop_items
  tables.financial_drop_items=[]
  await page.reload()
  await page.getByText('Notas fora da base ativa',{exact:true}).click()
  await page.getByRole('button',{name:'nf-teste.pdf',exact:true}).waitFor()
  assert.equal(invoiceRequests[0].financial_invoice_files.length,2)
  tables.financial_drop_items=invoiceItems
  await page.goto('http://127.0.0.1:5173/enviar-nf#token='+'b'.repeat(64))
  await page.getByRole('alert').filter({hasText:'Link expirado ou revogado.'}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Enviar nota fiscal',exact:true}).count(),0)
  await page.setViewportSize({width:1440,height:900})
  console.log('PASS: shared private invoice form, authorized review, receipts, filters and legacy links preserve stored invoices')

  await page.goto('http://127.0.0.1:5173/mensagens')
  await page.getByLabel('Rascunho de mensagem').waitFor()
  await page.waitForFunction(() => document.querySelector('[aria-label="Rascunho de mensagem"]')?.value === 'Rascunho anterior')
  assert.equal(await page.getByText('MODELO FINANCEIRO PRIVADO', { exact: true }).count(), 0)
  await page.getByLabel('Rascunho de mensagem').fill('Rascunho persistido no teste')
  await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Rascunho salvo com sucesso.' }).waitFor()
  await page.reload()
  await page.waitForFunction(() => document.querySelector('[aria-label="Rascunho de mensagem"]')?.value === 'Rascunho persistido no teste')
  console.log('PASS: draft survives reload; financial templates absent from ready messages')

  await page.goto('http://127.0.0.1:5173/financeiro/pagamento-total')
  const financialNote = page.getByLabel('Anotações do financeiro', { exact: true })
  await financialNote.fill('Revisar fechamento de outubro.\nConferir pagamentos pendentes.')
  await page.getByRole('button', { name: 'Salvar anotação', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Anotação salva.' }).waitFor()
  await page.reload()
  await page.waitForFunction(() => document.querySelector('[aria-label="Anotações do financeiro"]')?.value.includes('Conferir pagamentos pendentes.'))
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport)
    const geometry = await financialNote.evaluate(element => {
      const rect = element.getBoundingClientRect(), section = element.closest('.dashboard-notes-grid').getBoundingClientRect()
      return { width: rect.width, available: section.width, left: rect.left, right: rect.right, screen: innerWidth, font: parseFloat(getComputedStyle(element).fontSize) }
    })
    assert.ok(geometry.width >= geometry.available - 2 && geometry.font >= 16 && geometry.left >= 0 && geometry.right <= geometry.screen + 1, JSON.stringify(geometry))
    await page.locator('.financial-notes').screenshot({ path: `tmp/browser-tests/financial-notes-${viewport.width}.png` })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  console.log('PASS: financial note uses full width and readable input on desktop/portrait/landscape; saved text survives reload')

  await page.goto('http://127.0.0.1:5173/financeiro/pagamento-detalhes')
  await page.getByRole('columnheader', { name: 'Responsável', exact: true }).waitFor()
  await page.getByRole('cell', { name: 'Eduardo', exact: true }).waitFor()
  await page.getByRole('cell', { name: partner, exact: true }).waitFor()
  await page.getByRole('cell', { name: 'MOVIDOS', exact: true }).waitFor()
  await page.getByLabel('CNPJ de referência',{exact:true}).selectOption('MOVIDOS')
  await page.getByRole('button',{name:'Limpar filtros',exact:true}).click()
  assert.equal(await page.getByLabel('CNPJ de referência',{exact:true}).inputValue(),'')
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    const geometry = await page.locator('.email-template-grid textarea').evaluate(element => {
      const bounds = element.getBoundingClientRect()
      return { width: bounds.width, left: bounds.left, right: bounds.right, screen: innerWidth }
    })
    assert.ok(geometry.width >= 250 && geometry.left >= 0 && geometry.right <= geometry.screen + 1, JSON.stringify(geometry))
    await page.locator('.closing-emails').screenshot({ path: `tmp/browser-tests/email-${viewport.width}.png` })
  }
  console.log('PASS: responsible, logistics partner and reference; desktop/mobile email layout')

  await page.getByLabel('Período', { exact: true }).selectOption('SETEMBRO')
  await page.getByLabel('Parceiro', { exact: true }).selectOption(partner)
  let mailDownloads = 0
  const countMailDownload = () => { mailDownloads++ }
  page.on('download', countMailDownload)
  mailPilotRecipient = 'pilot@example.com'
  await page.getByRole('button', { name: 'Enviar e-mails', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Modo de teste ativo: os fechamentos dos clientes estão bloqueados por MAIL_TEST_RECIPIENT.' }).waitFor()
  assert.equal(mailRequests.length, 0)
  assert.equal(mailDownloads, 0)
  mailPilotRecipient = null
  page.once('dialog', dialog => dialog.dismiss())
  await page.getByRole('button', { name: 'Enviar e-mails', exact: true }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Enviar e-mails' && !button.disabled))
  assert.equal(mailRequests.length, 0)
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Enviar e-mails', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Aceitos pelo servidor de e-mail: 1.' }).waitFor()
  assert.equal(mailRequests.length, 1)
  assert.equal(mailDownloads, 0)
  mailUncertain = true
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Enviar e-mails', exact: true }).click()
  await page.getByRole('cell', { name: 'INCERTO', exact: true }).waitFor()
  mailConfigured = false
  await page.getByRole('button', { name: 'Enviar e-mails', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Conta remetente não configurada no teste.' }).waitFor()
  assert.equal(mailRequests.length, 2)
  assert.equal(mailDownloads, 0)
  mailConfigured = true
  await page.getByLabel('Período', { exact: true }).selectOption('')
  await page.getByLabel('Parceiro', { exact: true }).selectOption('')
  page.once('dialog', async dialog => {
    assert.match(dialog.message(), /fabioaf9@gmail.com/)
    await dialog.accept()
  })
  await page.getByRole('button', { name: 'Enviar teste', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Teste aceito pelo provedor para fabioaf9@gmail.com.' }).waitFor()
  assert.equal(mailRequests.length, 3)
  assert.deepEqual(mailRequests[2], { mode: 'test' })
  assert.equal(mailDownloads, 0)
  const writesBeforeVerify = writes.length
  await page.getByRole('button', { name: 'Verificar conexão', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Conexão e autenticação SMTP verificadas.' }).waitFor()
  assert.equal(mailRequests.length, 3)
  assert.equal(writes.length, writesBeforeVerify)
  assert.equal(mailDownloads, 0)
  mailConfigured = false
  await page.getByRole('button', { name: 'Verificar conexão', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Conta remetente não configurada no teste.' }).waitFor()
  assert.equal(mailRequests.length, 3)
  assert.equal(writes.length, writesBeforeVerify)
  mailConfigured = true
  mailTestBlocked = true
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Enviar teste', exact: true }).click()
  await page.getByRole('button', { name: 'Repetir teste', exact: true }).waitFor()
  assert.equal(mailRequests.length, 4)
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    const fits = await page.getByRole('button', { name: 'Repetir teste', exact: true }).evaluate(element => {
      const bounds = element.getBoundingClientRect()
      return bounds.left >= 0 && bounds.right <= innerWidth && element.scrollWidth <= element.clientWidth
    })
    assert.equal(fits, true)
    await page.locator('.closing-emails').screenshot({ path: `tmp/browser-tests/email-retry-${viewport.width}.png` })
  }
  page.once('dialog', async dialog => {
    assert.match(dialog.message(), /entrada\/spam de fabioaf9@gmail.com/)
    assert.match(dialog.message(), /UMA repetição/)
    await dialog.dismiss()
  })
  await page.getByRole('button', { name: 'Repetir teste', exact: true }).click()
  assert.equal(mailRequests.length, 4)
  await page.getByRole('button', { name: 'Verificar conexão', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Conexão e autenticação SMTP verificadas.' }).waitFor()
  await page.getByRole('button', { name: 'Repetir teste', exact: true }).waitFor()
  assert.equal(mailRequests.length, 4)
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Repetir teste', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Teste aceito pelo provedor para fabioaf9@gmail.com.' }).waitFor()
  assert.equal(mailRequests.length, 5)
  assert.deepEqual(mailRequests[4], { mode: 'test', retryOf: testRetryId, reconciled: true })
  mailRetryUncertain = true
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Enviar teste', exact: true }).click()
  await page.getByRole('button', { name: 'Repetir teste', exact: true }).waitFor()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Repetir teste', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Repetição sem confirmação' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Repetir teste', exact: true }).count(), 0)
  assert.equal(mailRequests.length, 7)
  assert.equal(writes.length, writesBeforeVerify)
  assert.equal(mailDownloads, 0)
  console.log('PASS: test retry requires mailbox confirmation, cancel does not send, verification does not retry and uncertain retry is not offered again')
  page.off('download', countMailDownload)
  console.log('PASS: direct email confirms before send, posts PDF without download and reports uncertain/unconfigured states')

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('http://127.0.0.1:5173/cadastros/novo?edit=drop1')
  await page.getByLabel('Data do contrato', { exact: true }).fill('2026-09-02')
  await page.getByLabel('Data do distrato', { exact: true }).fill('2026-09-15')
  await page.getByLabel('Motivo do distrato', { exact: true }).fill('Encerramento solicitado')
  for (const kind of ['contrato', 'distrato']) {
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: `Baixar ${kind} em PDF`, exact: true }).click()
    const download = await downloadPromise
    const file = `tmp/browser-tests/${kind}.pdf`
    await download.saveAs(file)
    const pdf = (await readFile(file)).toString('latin1')
    assert.ok(pdf.includes('02/09/2026'))
    if (kind === 'distrato') {
      assert.ok(pdf.includes('15/09/2026'))
      assert.ok(pdf.includes('Encerramento solicitado'))
    }
    const pdfPage=await context.newPage()
    await pdfPage.goto('http://127.0.0.1:5173/enviar-nf')
    const inspection=await pdfPage.evaluate(async bytes=>{
      const pdfjs=await import('/node_modules/pdfjs-dist/build/pdf.mjs')
      pdfjs.GlobalWorkerOptions.workerSrc='/node_modules/pdfjs-dist/build/pdf.worker.mjs'
      const loading=pdfjs.getDocument({data:new Uint8Array(bytes),useSystemFonts:true})
      const documentPdf=await loading.promise
      const overflows=[]
      for(let number=1;number<=documentPdf.numPages;number++){
        const page=await documentPdf.getPage(number),content=await page.getTextContent(),viewport=page.getViewport({scale:1})
        for(const item of content.items.filter(item=>item.str?.trim()&&!item.str.startsWith('MOVIDOS |'))){
          if(item.transform[4]<61||item.transform[4]+item.width>535||viewport.height-item.transform[5]>769)overflows.push(item.str)
        }
        if(number===1){
          const canvas=document.createElement('canvas')
          canvas.width=viewport.width*1.5;canvas.height=viewport.height*1.5
          document.body.replaceChildren(canvas);document.body.style.margin='0';document.body.style.background='white'
          await page.render({canvasContext:canvas.getContext('2d'),viewport:page.getViewport({scale:1.5})}).promise
        }
      }
      return {pages:documentPdf.numPages,overflows}
    },[...await readFile(file)])
    assert.deepEqual(inspection.overflows,[],`${kind}: text outside margins`)
    await pdfPage.locator('canvas').screenshot({path:`tmp/browser-tests/${kind}-render.png`})
    await pdfPage.close()
  }
  await page.locator('.cadastro-form').getByRole('button', { name: 'Salvar e sair', exact: true }).click()
  await page.waitForURL('**/cadastros')
  assert.equal(tables.drops[0].signed_at, '2026-09-02')
  assert.equal(tables.drops[0].terminated_at, '2026-09-15')
  assert.equal(tables.drops[0].termination_reason, 'Encerramento solicitado')
  console.log('PASS: PDFs use selected dates and termination reason; fields persist')

  await page.goto('http://127.0.0.1:5173/cadastros/novo?edit=drop1')
  const registrationStatus = page.getByRole('combobox', { name: 'Status', exact: true })
  await registrationStatus.waitFor()
  const statusValues = await registrationStatus.locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean))
  assert.deepEqual(statusValues, allowedDropStatuses)
  await registrationStatus.selectOption('EXCLUÍDO')
  const writesBeforeExclude = writes.length
  for (const response of [null, '   ']) {
    page.once('dialog', dialog => response === null ? dialog.dismiss() : dialog.accept(response))
    await page.getByRole('button', { name: 'Salvar e permanecer', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'A observação é obrigatória.' }).waitFor()
    assert.equal(writes.length, writesBeforeExclude)
    assert.equal(tables.drops[0].is_active, true)
  }
  rejectDropWrite = true
  page.once('dialog', dialog => dialog.accept('  Encerramento confirmado pelo cliente  '))
  await page.getByRole('button', { name: 'Salvar e permanecer', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Permissão negada no teste.' }).waitFor()
  assert.equal(page.url(), 'http://127.0.0.1:5173/cadastros/novo?edit=drop1')
  assert.equal(await registrationStatus.inputValue(), 'EXCLUÍDO')
  assert.equal(await page.getByRole('textbox', { name: 'Motivo da desativação', exact: true }).inputValue(), 'Encerramento confirmado pelo cliente')
  assert.equal(tables.drops[0].status, 'ATIVO')
  assert.equal(writes.length, writesBeforeExclude)
  rejectDropWrite = false; unchangedDropWrite = true
  await page.getByRole('button', { name: 'Salvar e permanecer', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'O banco não confirmou' }).waitFor()
  assert.equal(writes.length, writesBeforeExclude)
  unchangedDropWrite = false
  await page.getByRole('button', { name: 'Salvar e permanecer', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Cadastro desativado e motivo salvo.' }).waitFor()
  assert.equal(tables.drops[0].status, 'EXCLUÍDO')
  assert.equal(tables.drops[0].is_active, false)
  assert.equal(tables.drops[0].deactivated_reason, 'Encerramento confirmado pelo cliente')
  assert.equal(tables.drops[0].deactivated_by, user.id)
  assert.ok(Number.isFinite(Date.parse(tables.drops[0].deactivated_at)))
  assert.equal(await page.getByRole('textbox', { name: 'Nome do Drop', exact: true }).inputValue(), 'DROP TESTE')
  const savedDeactivation = { ...tables.drops[0] }
  await page.reload()
  await page.waitForFunction(() => [...document.querySelectorAll('select')].some(select => select.value === 'EXCLUÍDO'))
  await page.getByRole('button', { name: 'Salvar e permanecer', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Cadastro desativado e motivo salvo.' }).waitFor()
  assert.equal(tables.drops[0].deactivated_at, savedDeactivation.deactivated_at)
  assert.equal(tables.drops[0].deactivated_reason, savedDeactivation.deactivated_reason)
  await registrationStatus.selectOption('ENVIADO - AG. APROVAÇÃO')
  await page.getByRole('button', { name: 'Salvar e permanecer', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Cadastro salvo com sucesso.' }).waitFor()
  assert.equal(tables.drops[0].status, 'ENVIADO - AG. APROVAÇÃO')
  assert.equal(tables.drops[0].is_active, true)
  assert.equal(tables.drops[0].deactivated_reason, null)
  await registrationStatus.selectOption('ATIVO')
  await page.getByRole('button', { name: 'Salvar e sair', exact: true }).click()
  await page.waitForURL('**/cadastros')
  assert.equal(tables.drops[0].status, 'ATIVO')

  await page.goto('http://127.0.0.1:5173/cadastros/novo')
  const countBeforeCreate = tables.drops.length
  await page.getByRole('textbox', { name: 'Nome do Drop', exact: true }).fill('NOVO SEM SAIR')
  holdDropWrite = true
  const creationRequest = page.waitForRequest(request => request.method() === 'POST' && request.url().includes('/rest/v1/drops'))
  await page.getByRole('button', { name: 'Salvar e permanecer', exact: true }).click()
  await creationRequest
  assert.equal(await page.getByRole('button', { name: 'Salvar e permanecer', exact: true }).isDisabled(), true)
  await page.locator('form.cadastro-form').evaluate(form => form.requestSubmit())
  assert.equal(pendingDropWrites.length, 1)
  holdDropWrite = false
  pendingDropWrites.splice(0).forEach(finish => finish())
  await page.waitForURL('**/cadastros/novo?edit=*')
  await page.getByRole('status').filter({ hasText: 'Cadastro salvo com sucesso.' }).waitFor()
  assert.equal(tables.drops.length, countBeforeCreate + 1)
  const savedDropId = new URL(page.url()).searchParams.get('edit')
  await page.getByRole('textbox', { name: 'Nome do Drop', exact: true }).fill('NOVO SEM DUPLICAR')
  await page.getByRole('button', { name: 'Salvar e permanecer', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Cadastro salvo com sucesso.' }).waitFor()
  assert.equal(tables.drops.length, countBeforeCreate + 1)
  assert.equal(tables.drops.find(drop => drop.id === savedDropId).name, 'NOVO SEM DUPLICAR')
  await page.reload()
  await page.waitForFunction(() => [...document.querySelectorAll('input')].some(input => input.value === 'NOVO SEM DUPLICAR'))
  assert.equal(new URL(page.url()).searchParams.get('edit'), savedDropId)
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await page.getByRole('button', { name: 'Salvar e permanecer', exact: true }).scrollIntoViewIfNeeded()
    for (const name of ['Salvar e permanecer', 'Salvar e sair', 'Cancelar']) {
      const bounds = await page.getByRole('button', { name, exact: true }).evaluate(button => { const bounds = button.getBoundingClientRect(); return { left: bounds.left, right: bounds.right, screen: innerWidth, fits: button.scrollWidth <= button.clientWidth } })
      assert.ok(bounds.left >= 0 && bounds.right <= bounds.screen + 1 && bounds.fits, JSON.stringify(bounds))
    }
    await page.screenshot({ path: `tmp/browser-tests/cadastro-save-${viewport.width}.png` })
  }
  await page.goto('http://127.0.0.1:5173/cadastros/novo')
  assert.equal(await page.getByRole('textbox', { name: 'Nome do Drop', exact: true }).inputValue(), '')
  console.log('PASS: canonical excluded/approval status, required reason, persistent deactivation, visible failures, stay/save-exit and no duplicate inserts')

  await page.goto('http://127.0.0.1:5173/financeiro/pagamento-total')
  const totalRow = () => page.getByRole('row').filter({ has: page.getByText('SETEMBRO', { exact: true }) })
  await totalRow().getByRole('button', { name: 'Editar', exact: true }).click()
  let editor = page.getByRole('dialog', { name: 'Editar pagamento total' })
  assert.equal(await editor.locator('input').count(), 2)
  await editor.getByLabel('Total líquido a receber', { exact: true }).fill('0')
  await editor.getByLabel('Data do pagamento', { exact: true }).fill('2026-09-22')
  await editor.getByRole('button', { name: 'Salvar alterações', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Total líquido e data do pagamento atualizados.' }).waitFor()
  assert.equal(tables.financial_periods[0].net_amount, 0)
  assert.equal(tables.financial_periods[0].payment_date, '2026-09-22')
  assert.equal(tables.financial_periods[0].partner, 'Eduardo')
  await page.reload()
  await totalRow().getByRole('button', { name: 'Editar', exact: true }).click()
  assert.equal(await editor.getByLabel('Total líquido a receber', { exact: true }).inputValue(), '0')
  tables.financial_periods[0].net_amount = 123
  await editor.getByLabel('Total líquido a receber', { exact: true }).fill('99')
  await editor.getByRole('button', { name: 'Salvar alterações', exact: true }).click()
  await editor.getByRole('alert').filter({ hasText: 'O registro mudou' }).waitFor()
  assert.equal(tables.financial_periods[0].net_amount, 123)
  await editor.getByRole('button', { name: 'Cancelar', exact: true }).click()
  tables.financial_periods[0].net_amount = null
  tables.financial_periods.push({ ...tables.financial_periods[0], id: 'p2', partner: 'Felipe' })
  const preserved = { source: 'legacy', recovery: { hash: 'unchanged' }, summary: { invoice: 1000, reimbursement: 5, other: 'preserved' } }
  tables.financial_views[0].notes = JSON.stringify(preserved)
  await page.reload()
  await totalRow().getByRole('button', { name: 'Editar', exact: true }).click()
  await editor.getByLabel('Total líquido a receber', { exact: true }).fill('1200.50')
  await editor.getByLabel('Data do pagamento', { exact: true }).fill('2026-09-23')
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    const fits = await editor.evaluate(element => { const bounds = element.getBoundingClientRect(); return bounds.left >= 0 && bounds.right <= innerWidth })
    assert.equal(fits, true)
    await page.screenshot({ path: `tmp/browser-tests/payment-total-edit-${viewport.width}.png` })
  }
  await editor.getByRole('button', { name: 'Salvar alterações', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Total líquido e data do pagamento atualizados.' }).waitFor()
  assert.deepEqual(JSON.parse(tables.financial_views[0].notes), { ...preserved, summary: { ...preserved.summary, invoice: 1200.5, paymentDate: '2026-09-23' } })
  assert.ok(tables.financial_periods.every(period => period.net_amount === null))
  await page.reload()
  await totalRow().getByRole('cell', { name: '23/09/2026', exact: true }).waitFor()
  console.log('PASS: payment total edits only net/date, preserves metadata and zero, rejects stale writes and survives reload')

  await page.goto('http://127.0.0.1:5173/cadastros/last-mile')
  await page.getByRole('button', { name: '+ Novo cadastro', exact: true }).click()
  await page.waitForURL('**/cadastros/last-mile/novo')
  await page.getByRole('heading', { name: 'Fotos do ponto', exact: true }).waitFor()
  await page.getByRole('heading', { name: 'Contratos e distratos', exact: true }).waitFor()
  await page.getByRole('heading', { name: /Modelo do contrato/ }).waitFor()
  assert.equal(await page.getByLabel('Anexar fotos', { exact: true }).count(), 0)
  const dropCount = tables.drops.length
  await page.getByLabel('Nome', { exact: true }).fill('LAST MILE TESTE')
  const vehicleOptions = await page.getByRole('combobox', { name: 'Tipo de veículo', exact: true }).locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean))
  assert.ok(vehicleOptions.includes('Moto') && vehicleOptions.includes('Carro') && vehicleOptions.includes('Van'))
  assert.ok(!vehicleOptions.some(option => ['CPF', 'CNPJ', 'E-mail', 'Telefone', 'Chave aleatória'].includes(option)))
  await page.getByRole('combobox', { name: 'Tipo de veículo', exact: true }).selectOption('Moto')
  await page.getByRole('combobox', { name: 'Tipo de chave PIX', exact: true }).selectOption('CPF')
  await page.getByLabel('Chave PIX', { exact: true }).fill('12345678901')
  await page.getByLabel('Placa do veículo', { exact: true }).fill('ABC1D23')
  rejectDropWrite = true
  await page.getByRole('button', { name: 'Salvar cadastro Last Mile', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Não foi possível salvar o cadastro Last Mile.' }).waitFor()
  assert.equal(tables.drops.length, dropCount)
  assert.equal(await page.getByLabel('Nome', { exact: true }).inputValue(), 'LAST MILE TESTE')
  assert.equal(await page.getByRole('combobox', { name: 'Tipo de veículo', exact: true }).inputValue(), 'Moto')
  rejectDropWrite = false
  await page.getByRole('button', { name: 'Salvar cadastro Last Mile', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Cadastro Last Mile salvo.' }).waitFor()
  const lastMile = tables.drops.find(drop => drop.registration_type === 'last_mile')
  assert.ok(lastMile)
  assert.equal(lastMile.partner, null)
  assert.equal(lastMile.vehicle_type, 'Moto')
  assert.equal(lastMile.pix_key_type, 'CPF')
  assert.equal(lastMile.pix_key, '12345678901')
  assert.equal(lastMile.vehicle_plate, 'ABC1D23')
  await page.getByLabel('Nome', { exact: true }).fill('LAST MILE ATUALIZADO')
  await page.getByRole('combobox', { name: 'Parceiro logístico', exact: true }).selectOption('J&T EXPRESS LTDA')
  await page.getByRole('button', { name: 'Salvar alterações', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Cadastro Last Mile salvo.' }).waitFor()
  assert.equal(tables.drops.length, dropCount + 1)
  assert.equal(lastMile.name, 'LAST MILE ATUALIZADO')
  assert.equal(lastMile.partner, 'J&T EXPRESS LTDA')
  await page.getByLabel('Anexar fotos', { exact: true }).setInputFiles({ name: 'fachada.png', mimeType: 'image/png', buffer: photoBytes })
  await page.locator('.drop-photos img').waitFor()
  for (const kind of ['contrato', 'distrato']) {
    await page.getByLabel(`Anexar ${kind}`, { exact: true }).setInputFiles({ name: `${kind}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nTest attachment\n%%EOF') })
    await page.locator('.drop-documents').getByRole('button', { name: `${kind}.pdf`, exact: true }).waitFor()
  }
  assert.deepEqual(tables.drop_documents.map(document => document.kind).sort(), ['contrato', 'distrato', 'foto'])
  assert.ok(tables.drop_documents.every(document => document.drop_id === lastMile.id && document.storage_path.startsWith(`drops/${lastMile.id}/`)))
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await page.locator('.drop-photos').scrollIntoViewIfNeeded()
    const bounds = await page.locator('.drop-photos').evaluate(element => { const bounds = element.getBoundingClientRect(); return { left: bounds.left, right: bounds.right, screen: innerWidth } })
    if (bounds.left < 0 || bounds.right > bounds.screen + 1) {
      const overflow = await page.locator('.last-mile-cadastro').evaluate(element => [element, ...element.querySelectorAll('*')].map(node => {
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node)
        return { tag: node.tagName, class: node.className, width: rect.width, right: rect.right, min: style.minWidth, grid: style.gridTemplateColumns }
      }).filter(row => row.right > innerWidth + 1))
      assert.fail(JSON.stringify({ bounds, overflow }))
    }
    assert.equal(await page.locator('.drop-photos img').evaluate(image => image.complete && image.naturalWidth > 0), true)
    await page.screenshot({ path: `tmp/browser-tests/last-mile-attachments-${viewport.width}.png`, fullPage: true })
  }
  const serviceEditor = page.getByRole('region', { name: 'Modelo de contrato', exact: true })
  const defaultModelDownload = page.waitForEvent('download')
  await serviceEditor.getByRole('button', { name: 'Baixar modelo atual (Word)', exact: true }).click()
  assert.deepEqual(await readFile(await (await defaultModelDownload).path()), await readFile('public/templates/modelo-contrato-prestacao-servico.docx'))
  await page.getByLabel('Alterar modelo do contrato', { exact: true }).setInputFiles({ name: 'modelo.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await readFile('public/templates/modelo-contrato-prestacao-servico.docx') })
  await page.getByText('Modelo de contrato ativado para os próximos documentos.', { exact: true }).waitFor()
  assert.match(serviceTemplatePath, /^contract-templates\/service\//)
  await page.getByLabel('Alterar modelo do distrato',{exact:true}).setInputFiles({name:'distrato.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:await readFile('public/templates/modelo-distrato-sociedade.docx')})
  await page.getByText('Modelo de distrato ativado para os próximos documentos.',{exact:true}).waitFor()
  assert.match(terminationTemplatePath,/^contract-templates\/termination\//)
  await page.reload()
  for (const kind of ['contrato', 'distrato']) {
    const templateEditor = page.getByRole('region', { name: `Modelo de ${kind}`, exact: true })
    await templateEditor.getByText('Modelo personalizado ativo.', { exact: true }).waitFor()
    const activeDownload = page.waitForEvent('download')
    await templateEditor.getByRole('button', { name: 'Baixar modelo atual (Word)', exact: true }).click()
    const downloaded = await activeDownload
    assert.equal(downloaded.suggestedFilename(), `modelo-${kind}-atual.docx`)
    assert.deepEqual(await readFile(await downloaded.path()), await readFile(kind === 'contrato' ? 'public/templates/modelo-contrato-prestacao-servico.docx' : 'public/templates/modelo-distrato-sociedade.docx'))
    const pathsBeforeDownload = [serviceTemplatePath, terminationTemplatePath]
    const originalDownload = page.waitForEvent('download')
    await templateEditor.getByRole('link', { name: 'Baixar modelo original (Word)', exact: true }).click()
    assert.deepEqual(await readFile(await (await originalDownload).path()), await readFile(kind === 'contrato' ? 'public/templates/modelo-contrato-prestacao-servico.docx' : 'public/templates/modelo-distrato-sociedade.docx'))
    assert.deepEqual([serviceTemplatePath, terminationTemplatePath], pathsBeforeDownload)
  }
  rejectTemplateLoad = true
  await page.reload()
  for (const kind of ['contrato', 'distrato']) {
    const templateEditor = page.getByRole('region', { name: `Modelo de ${kind}`, exact: true })
    await templateEditor.getByText('Modelo indisponível.', { exact: true }).waitFor()
    assert.equal(await templateEditor.getByRole('button', { name: 'Baixar modelo atual (Word)', exact: true }).isDisabled(), true)
    assert.equal(await templateEditor.getByRole('button', { name: 'Enviar modelo atualizado', exact: true }).isDisabled(), true)
  }
  rejectTemplateLoad = false
  for (const kind of ['contrato', 'distrato']) {
    const templateEditor = page.getByRole('region', { name: `Modelo de ${kind}`, exact: true })
    await templateEditor.getByRole('button', { name: 'Tentar novamente', exact: true }).click()
    await templateEditor.getByText('Modelo personalizado ativo.', { exact: true }).waitFor()
  }
  rejectTemplateDownload = true
  await serviceEditor.getByRole('button', { name: 'Baixar modelo atual (Word)', exact: true }).click()
  await serviceEditor.getByRole('status').filter({ hasText: 'Não foi possível baixar o modelo ativo.' }).waitFor()
  rejectTemplateDownload = false
  const recoveredDownload = page.waitForEvent('download')
  await serviceEditor.getByRole('button', { name: 'Baixar modelo atual (Word)', exact: true }).click()
  assert.equal((await recoveredDownload).suggestedFilename(), 'modelo-contrato-atual.docx')
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport)
    const buttonsFit = await page.locator('.template-editor button, .template-editor a').evaluateAll(buttons => buttons.every(button => {
      const rect = button.getBoundingClientRect()
      return rect.left >= 0 && rect.right <= innerWidth + 1 && rect.height >= 44 && button.scrollWidth <= button.clientWidth + 1
    }))
    assert.equal(buttonsFit, true, JSON.stringify(await page.locator('.template-editor button, .template-editor a').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect()
      return { text: element.textContent, left: rect.left, right: rect.right, height: rect.height, client: element.clientWidth, scroll: element.scrollWidth, screen: innerWidth }
    }))))
    await serviceEditor.screenshot({ path: `tmp/browser-tests/template-editor-${viewport.width}.png` })
  }
  await page.getByRole('button', { name: 'Restaurar modelo padrão', exact: true }).click()
  await page.getByText('Modelo padrão restaurado para os próximos contratos.', { exact: true }).waitFor()
  assert.equal(serviceTemplatePath, '')
  assert.match(terminationTemplatePath,/^contract-templates\/termination\//)
  await page.getByRole('button',{name:'Restaurar modelo padrão do distrato',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('[aria-label="Modelo de distrato"]')?.textContent.includes('Modelo padrão ativo.'))
  assert.equal(terminationTemplatePath,'')
  await page.goto(`http://127.0.0.1:5173/cadastros/novo?edit=${lastMile.id}`)
  await page.getByRole('combobox', { name: 'Tipo de veículo', exact: true }).waitFor()
  assert.equal(await page.getByRole('combobox', { name: 'Tipo de veículo', exact: true }).inputValue(), 'Moto')
  assert.equal(await page.getByRole('combobox', { name: 'Tipo de chave PIX', exact: true }).inputValue(), 'CPF')
  assert.equal(await page.getByLabel('Placa do veículo', { exact: true }).inputValue(), 'ABC1D23')
  await page.getByRole('combobox', { name: 'Tipo de veículo', exact: true }).selectOption('Van')
  await page.getByRole('button', { name: 'Salvar e permanecer', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Cadastro salvo com sucesso.' }).waitFor()
  await page.reload()
  await page.getByRole('combobox', { name: 'Tipo de veículo', exact: true }).waitFor()
  assert.equal(await page.getByRole('combobox', { name: 'Tipo de veículo', exact: true }).inputValue(), 'Van')
  assert.equal(lastMile.pix_key_type, 'CPF')
  assert.equal(lastMile.pix_key, '12345678901')
  assert.equal(tables.drops.length, dropCount + 1)
  await page.locator('.drop-documents').getByRole('button', { name: 'contrato.pdf', exact: true }).waitFor()
  await page.locator('.drop-photos img').waitFor()
  const attachmentDownload = page.waitForEvent('download')
  await page.locator('.drop-documents').getByRole('button', { name: 'contrato.pdf', exact: true }).click()
  assert.equal((await attachmentDownload).suggestedFilename(), 'contrato.pdf')
  tables.user_profiles[0].role = 'operador'
  Object.assign(tables.user_module_permissions[0], { cadastros_view: true, cadastros_create: true, financeiro_view: true, financeiro_manage: false })
  await page.goto('http://127.0.0.1:5173/cadastros/last-mile/novo')
  await page.getByRole('heading', { name: 'Fotos do ponto', exact: true }).waitFor()
  assert.equal(await page.getByRole('heading', { name: /Modelo do contrato/ }).count(), 0)
  await page.goto('http://127.0.0.1:5173/financeiro/pagamento-total')
  await totalRow().waitFor()
  assert.equal(await page.getByRole('button', { name: 'Editar', exact: true }).count(), 0)
  assert.equal(await page.getByLabel('Anotações do financeiro', { exact: true }).getAttribute('readonly'), '')
  assert.equal(await page.getByRole('button', { name: 'Salvar anotação', exact: true }).count(), 0)
  tables.user_profiles[0].role = 'admin'
  console.log('PASS: Last Mile photos/contracts persist under one ID, model edit is admin-only and finance viewer cannot edit totals')

  await page.goto('http://127.0.0.1:5173/financeiro')
  await page.getByLabel('Período do fechamento').fill('NOVO PERIODO')
  await page.getByLabel('Início da quinzena', { exact: true }).fill('2026-09-01')
  await page.getByLabel('Fim da quinzena', { exact: true }).fill('2026-09-15')
  const templateDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Baixar modelo', exact: true }).click()
  const downloadedTemplate = await templateDownload
  assert.equal(downloadedTemplate.suggestedFilename(), 'modelo-fechamento-financeiro.xlsx')
  const downloadedWorkbook = XLSX.read(await readFile(await downloadedTemplate.path()), { type: 'buffer' })
  assert.deepEqual(XLSX.utils.sheet_to_json(downloadedWorkbook.Sheets['Pagamento Total'], { header: 1 })[0], ['Periodo', 'Parceiro', 'TotalLiquidoAReceber', 'DataPagamento','CNPJReferencia'])
  assert.equal(downloadedWorkbook.Sheets['Pagamento Total'].A2.v, 'NOVO PERIODO')
  const workbook = createClosingTemplate()
  workbook.Sheets.Fechamento = XLSX.utils.aoa_to_sheet([['Periodo', 'Parceiro', 'Drop', 'QuantidadePacote', 'CNPJReferencia'], ['', partner, 'DROP TESTE', 100, 'MOVIDOS']])
  workbook.Sheets['Pagamento Total'] = XLSX.utils.aoa_to_sheet([['Periodo', 'Parceiro', 'TotalLiquidoAReceber', 'DataPagamento'], ['OUTRO PERIODO', partner, 999.99, 46280]])
  const writesBeforeWrongPeriod = writes.length
  await page.locator('.finance-upload input[type="file"]').setInputFiles({ name: 'periodo-divergente.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) })
  await page.getByText('Pagamento Total: o período OUTRO PERIODO não corresponde ao fechamento NOVO PERIODO.', { exact: true }).waitFor()
  assert.equal(writes.length, writesBeforeWrongPeriod)
  workbook.Sheets['Pagamento Total'].A2.v = 'NOVO PERIODO'
  workbook.Sheets.Fechamento.A2.v = 'OUTRO PERIODO'
  await page.locator('.finance-upload input[type="file"]').setInputFiles({ name: 'fechamento-divergente.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) })
  await page.getByText('O período OUTRO PERIODO da planilha não corresponde ao fechamento NOVO PERIODO.', { exact: true }).waitFor()
  assert.equal(writes.length, writesBeforeWrongPeriod)
  workbook.Sheets.Fechamento.A2.v = ''
  missingLogisticsColumn = true
  const importFile = { name: 'fechamento-teste.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) }
  await page.locator('.finance-upload input[type="file"]').setInputFiles(importFile)
  await page.getByText(/Erro ao importar \(verificar a estrutura do banco\).*logistics_partner.*20260917130000_prepare_financial_logistics_columns.sql/).waitFor()
  assert.equal(writes.length, writesBeforeWrongPeriod)
  assert.equal(await page.locator('.finance-upload input[type="file"]').inputValue(), '')
  missingLogisticsColumn = false
  missingRegistrationSnapshot = true
  await page.locator('.finance-upload input[type="file"]').setInputFiles(importFile)
  await page.getByText(/Erro ao importar \(verificar a estrutura do banco\).*registration_snapshot.*20261014120000_financial_registration_snapshots.sql/).waitFor()
  assert.equal(writes.length, writesBeforeWrongPeriod)
  missingRegistrationSnapshot = false
  rejectClosingWrite = true
  await page.locator('.finance-upload input[type="file"]').setInputFiles({ name: 'fechamento-negado.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) })
  await page.getByText('Erro ao importar (criar a View): Permissão negada no teste de importação. (código 42501)', { exact: true }).waitFor()
  assert.equal(writes.length, writesBeforeWrongPeriod)
  rejectClosingWrite = false
  await page.locator('.finance-upload input[type="file"]').setInputFiles(importFile)
  await page.getByText('View de NOVO PERIODO importada com sucesso e consolidado geral atualizado.', { exact: true }).waitFor()
  const imported = tables.financial_periods.find(row => row.label === 'NOVO PERIODO')
  assert.equal(imported.net_amount, 999.99)
  assert.equal(imported.payment_date, '2026-09-15')
  console.log('PASS: downloaded template includes selected period, mismatches write nothing and imported closing stores net/date once per partner')

  await page.getByLabel('Período do fechamento').fill('TESTE PARCIAL')
  workbook.Sheets['Pagamento Total'].A2.v = 'TESTE PARCIAL'
  rejectClosingItems = true
  const writesBeforePartial = writes.length
  await page.locator('.finance-upload input[type="file"]').setInputFiles({ ...importFile, buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) })
  await page.getByText(/Erro ao importar \(gravar os itens do fechamento\).*22003.*Não reenvie a planilha/).waitFor()
  const partialView = tables.financial_views.find(row => row.title === 'TESTE PARCIAL')
  assert.equal(partialView.import_status, 'rascunho')
  assert.deepEqual(writes.slice(writesBeforePartial).map(write => write.table), ['financial_views', 'financial_periods'])
  assert.equal(tables.financial_periods.some(row => row.financial_view_id === partialView.id), true)
  rejectClosingItems = false
  console.log('PASS: missing logistics column stops before writes; structured errors expose stage/code and partial imports are explicitly flagged without deleting records')

  {
    const priorTables = structuredClone(tables)
    const priorPaymentRequests = paymentRequests.length
    tables.drops = [{ id: 'snapshot-drop', name: 'MGC 5', partner, responsible: 'Davi', pix_key: '00111222333', pix_holder_name: 'Davi', cpf: '00111222333', email: 'davi@example.test', monthly_value: .25, is_active: true, status: 'ATIVO' }]
    tables.financial_views = []; tables.financial_periods = []; tables.financial_drop_items = []; tables.financial_payment_history = []; tables.loss_events = []
    const importSnapshot = async period => {
      const sheet = createClosingTemplate(period)
      sheet.Sheets.Fechamento = XLSX.utils.aoa_to_sheet([['Periodo','Parceiro','Drop','QuantidadePacote','CNPJReferencia'],[period,partner,'MGC 5',100,'MOVIDOS']])
      sheet.Sheets['Pagamento Total'] = XLSX.utils.aoa_to_sheet([['Periodo','Parceiro','TotalLiquidoAReceber','DataPagamento','CNPJReferencia'],[period,partner,100,'14/10/2026','MOVIDOS']])
      await page.goto('http://127.0.0.1:5173/financeiro')
      await page.getByLabel('Período do fechamento').fill(period)
      await page.getByLabel('Início da quinzena', { exact: true }).fill('2026-09-01')
      await page.getByLabel('Fim da quinzena', { exact: true }).fill('2026-09-15')
      await page.locator('.finance-upload input[type="file"]').setInputFiles({ name: 'snapshot.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(sheet, { type: 'buffer', bookType: 'xlsx' }) })
      await page.getByText(`View de ${period} importada com sucesso e consolidado geral atualizado.`, { exact: true }).waitFor()
    }
    await importSnapshot('SNAPSHOT DAVI')
    const saved = structuredClone(tables.financial_drop_items[0])
    assert.equal(saved.registration_snapshot.responsible, 'Davi'); assert.equal(saved.unit_value, .25)
    Object.assign(tables.drops[0], { responsible: 'Gustavo', pix_key: '99999888777', email: 'gustavo@example.test', monthly_value: .5, pix_holder_name: 'Gustavo', cpf: '99999888777' })
    await importSnapshot('SNAPSHOT GUSTAVO')
    assert.equal(tables.financial_drop_items[1].registration_snapshot.responsible, 'Gustavo')
    assert.equal(tables.financial_drop_items[1].unit_value, .5)
    assert.deepEqual(tables.financial_drop_items[0], saved)
    await page.goto('http://127.0.0.1:5173/financeiro/pagamento-detalhes')
    await page.getByLabel('Período', { exact: true }).selectOption('SNAPSHOT DAVI')
    const oldRow = page.locator('.payment-details-table tbody tr:not(.financial-totals)')
    await oldRow.getByRole('cell', { name: 'Davi', exact: true }).waitFor()
    assert.equal(await oldRow.getByRole('cell', { name: '00111222333', exact: true }).count(), 1)
    const originalText = await oldRow.innerText()
    tables.drops[0].name = 'MGC RENOMEADO'; tables.drops[0].partner = 'J&T EXPRESS LTDA'; tables.drops[0].is_active = false
    await page.reload()
    await page.getByLabel('Período', { exact: true }).selectOption('SNAPSHOT DAVI')
    await oldRow.getByRole('cell', { name: 'Davi', exact: true }).waitFor()
    assert.equal(await oldRow.innerText(), originalText)
    const pdfDownload = page.waitForEvent('download')
    await oldRow.getByRole('button', { name: 'Gerar PDF', exact: true }).click()
    const pdf = await readFile(await (await pdfDownload).path())
    assert.ok(pdf.includes(Buffer.from('00111222333'))); assert.ok(!pdf.includes(Buffer.from('99999888777')))
    const excelDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Baixar Excel do fechamento', exact: true }).click()
    const exported = XLSX.read(await readFile(await (await excelDownload).path()), { type: 'buffer' }).Sheets['Pagamento Detalhes']
    assert.equal(exported.D3.v, 'Davi'); assert.equal(exported.G3.v, .25); assert.equal(exported.O3.v, '00111222333')
    await oldRow.getByRole('button', { name: 'Editar', exact: true }).click()
    const editor = page.getByRole('dialog')
    assert.equal(await editor.getByLabel('E-mail do fechamento', { exact: true }).inputValue(), 'davi@example.test')
    assert.equal(await editor.getByLabel('CPF/CNPJ do favorecido', { exact: true }).inputValue(), '00111222333')
    await editor.getByLabel('Responsável', { exact: true }).fill('Davi corrigido')
    await editor.getByLabel('PIX', { exact: true }).fill('')
    await editor.getByLabel('E-mail do fechamento', { exact: true }).fill('davi.corrigido@example.test')
    await editor.getByRole('button', { name: 'Salvar alterações', exact: true }).click()
    await editor.waitFor({ state: 'hidden' })
    await page.reload()
    await page.getByLabel('Período', { exact: true }).selectOption('SNAPSHOT DAVI')
    await oldRow.getByRole('cell', { name: 'Davi corrigido', exact: true }).waitFor()
    await oldRow.getByRole('button', { name: 'Editar', exact: true }).click()
    assert.equal(await editor.getByLabel('PIX', { exact: true }).inputValue(), '')
    assert.equal(await editor.getByLabel('E-mail do fechamento', { exact: true }).inputValue(), 'davi.corrigido@example.test')
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      assert.ok(await editor.evaluate(element => element.scrollWidth <= element.clientWidth))
      await editor.getByLabel('E-mail do fechamento', { exact: true }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: `tmp/browser-tests/closing-snapshot-${viewport.width}.png` })
    }
    await editor.getByRole('button', { name: 'Cancelar', exact: true }).click()
    assert.equal(tables.financial_drop_items[1].registration_snapshot.responsible, 'Gustavo')
    assert.deepEqual(tables.financial_drop_items[0], saved)
    Object.assign(tables, priorTables); paymentRequests.length = priorPaymentRequests
    await page.setViewportSize({ width: 1440, height: 900 })
    console.log('PASS: import snapshots Davi, next import captures Gustavo, old closing survives rename/deactivation and keeps PDF/Excel values; direct financial edits persist including empty PIX')
  }

  {
    const previousTables = structuredClone(tables)
    const previousPayments = paymentRequests.length
    tables.financial_views = []; tables.financial_periods = []; tables.financial_drop_items = []; tables.financial_payment_history = []; tables.loss_events = []
    tables.drops = [
      { id: 'davi', name: 'MGC 5', partner, responsible: 'Davi', pix_key: '00111222333', email: 'davi@example.test', monthly_value: .25, operation_started_at: '2026-08-01', operation_ended_at: '2026-10-10', is_active: false, status: 'EXCLUIDO' },
      { id: 'gustavo', name: 'MGC 5', partner, responsible: 'Gustavo', pix_key: '99999888777', email: 'gustavo@example.test', monthly_value: .5, operation_started_at: '2026-10-11', operation_ended_at: null, is_active: true, status: 'ATIVO' },
    ]
    const upload = async (title, start, end, withLosses = false) => {
      const workbook = createClosingTemplate(title)
      workbook.Sheets.Fechamento = XLSX.utils.aoa_to_sheet([['Periodo','Parceiro','Drop','QuantidadePacote','CNPJReferencia'],[title,partner,'MGC 5',100,'MOVIDOS']])
      workbook.Sheets['Pagamento Total'] = XLSX.utils.aoa_to_sheet([['Periodo','Parceiro','TotalLiquidoAReceber','DataPagamento','CNPJReferencia'],[title,partner,100,'20/10/2026','MOVIDOS']])
      if (withLosses) workbook.Sheets.Extravios = XLSX.utils.aoa_to_sheet([['Periodo','Parceiro','Drop','CNPJReferencia','Waybill','CodigoEtiqueta','Saca','Status','Seller','DataRecebimento','ValorExtravio','Obs'],[title,partner,'MGC 5','MOVIDOS','WB-DAVI','','','PUDO Missing','','',2,''],[title,partner,'MGC 5','MOVIDOS','WB-GUSTAVO','','','D2D Missing','','',3,'']])
      await page.goto('http://127.0.0.1:5173/financeiro')
      await page.getByLabel('Período do fechamento').fill(title)
      await page.getByLabel('Início da quinzena', { exact: true }).fill(start)
      await page.getByLabel('Fim da quinzena', { exact: true }).fill(end)
      await page.locator('.finance-upload input[type="file"]').setInputFiles({ name: 'troca.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) })
    }
    await upload('39. 2Q DE SETEMBRO', '2026-09-16', '2026-09-30')
    await page.getByText('View de 39. 2Q DE SETEMBRO importada com sucesso e consolidado geral atualizado.', { exact: true }).waitFor()
    assert.equal(tables.financial_drop_items[0].registration_snapshot.responsible, 'Davi')
    assert.equal(tables.financial_drop_items[0].quantity_packages, 100)
    const before = structuredClone({ items: tables.financial_drop_items, periods: tables.financial_periods })
    const writesBefore = writes.length
    await upload('40. 1Q DE OUTUBRO', '2026-10-01', '2026-10-15', true)
    const division = page.getByRole('form', { name: 'Divisão por responsável', exact: true })
    await division.waitFor()
    assert.equal(writes.length, writesBefore)
    await division.getByRole('button', { name: 'Cancelar divisão', exact: true }).click()
    await page.getByText('Importação cancelada. Nenhum registro foi criado.', { exact: true }).waitFor()
    assert.equal(writes.length, writesBefore)
    await upload('40. 1Q DE OUTUBRO', '2026-10-01', '2026-10-15', true)
    await division.waitFor()
    await division.getByLabel('Pacotes de Davi - linha 1', { exact: true }).fill('70')
    await division.getByLabel('Pacotes de Gustavo - linha 1', { exact: true }).fill('20')
    await division.getByLabel('Responsável pelo extravio 1', { exact: true }).selectOption('davi')
    await division.getByLabel('Responsável pelo extravio 2', { exact: true }).selectOption('gustavo')
    await division.getByRole('button', { name: 'Confirmar divisão e importar', exact: true }).click()
    await page.getByText(/A soma dos pacotes deve ser igual/).waitFor()
    assert.equal(writes.length, writesBefore)
    await division.getByLabel('Pacotes de Gustavo - linha 1', { exact: true }).fill('30')
    tables.drops[1].monthly_value = .6
    await division.getByRole('button', { name: 'Confirmar divisão e importar', exact: true }).click()
    await page.getByText(/Os cadastros ou valores mudaram durante a conferencia/).waitFor()
    assert.equal(writes.length, writesBefore)
    tables.drops[1].monthly_value = .5
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await division.scrollIntoViewIfNeeded()
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      for (const control of await division.locator('input,select,button').all()) assert.ok(await control.evaluate(element => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth + 1 }))
      await page.screenshot({ path: `tmp/browser-tests/operation-division-${viewport.width}.png`, fullPage: true })
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await division.getByRole('button', { name: 'Confirmar divisão e importar', exact: true }).click()
    await page.getByText('View de 40. 1Q DE OUTUBRO importada com sucesso e consolidado geral atualizado.', { exact: true }).waitFor()
    const transition = tables.financial_periods.find(row => row.label === '40. 1Q DE OUTUBRO')
    const split = tables.financial_drop_items.filter(row => row.financial_period_id === transition.id)
    assert.deepEqual(split.map(row => [row.registration_snapshot.responsible, row.quantity_packages, row.unit_value]), [['Davi',70,.25],['Gustavo',30,.5]])
    assert.deepEqual(tables.loss_events.map(row => [row.waybill,row.drop_id]), [['WB-DAVI','davi'],['WB-GUSTAVO','gustavo']])
    assert.deepEqual(tables.financial_drop_items[0], before.items[0])
    await upload('41. 2Q DE OUTUBRO', '2026-10-16', '2026-10-31')
    await page.getByText('View de 41. 2Q DE OUTUBRO importada com sucesso e consolidado geral atualizado.', { exact: true }).waitFor()
    assert.equal(tables.financial_drop_items.at(-1).registration_snapshot.responsible, 'Gustavo')
    assert.equal(tables.financial_drop_items.at(-1).quantity_packages, 100)
    const fullOwners = tables.drops
    tables.drops = [{ ...fullOwners[0], operation_started_at: '2026-11-01', operation_ended_at: '2026-11-10' }]
    const beforePartial = writes.length
    await upload('42. 1Q DE NOVEMBRO', '2026-11-01', '2026-11-15')
    await division.waitFor()
    assert.equal(writes.length, beforePartial)
    assert.equal(await division.getByLabel('Pacotes de Davi - linha 1', { exact: true }).inputValue(), '100')
    await division.getByRole('button', { name: 'Confirmar divisão e importar', exact: true }).click()
    await page.getByText('View de 42. 1Q DE NOVEMBRO importada com sucesso e consolidado geral atualizado.', { exact: true }).waitFor()
    const partial = tables.financial_drop_items.at(-1)
    assert.equal(partial.registration_snapshot.effectiveEnd, '2026-11-10')
    assert.equal(partial.quantity_packages * partial.unit_value, 25)
    tables.drops = fullOwners
    tables.drops.forEach(row => { row.responsible = 'ALTERADO'; row.monthly_value = 999; row.pix_key = 'ALTERADO' })
    await page.goto('http://127.0.0.1:5173/financeiro/pagamento-detalhes')
    await page.getByLabel('Período', { exact: true }).selectOption('40. 1Q DE OUTUBRO')
    const table = page.locator('.payment-details-table')
    const daviRow = table.locator('tr').filter({ has: page.getByRole('cell', { name: 'Davi', exact: true }) })
    const gustavoRow = table.locator('tr').filter({ has: page.getByRole('cell', { name: 'Gustavo', exact: true }) })
    await daviRow.waitFor(); await gustavoRow.waitFor()
    assert.match(await daviRow.innerText(), /15,50/); assert.match(await gustavoRow.innerText(), /12,00/)
    const pdfDownload = page.waitForEvent('download')
    await daviRow.getByRole('button', { name: 'Gerar PDF', exact: true }).click()
    const pdf = await readFile(await (await pdfDownload).path())
    assert.ok(pdf.includes(Buffer.from('WB-DAVI'))); assert.ok(!pdf.includes(Buffer.from('WB-GUSTAVO')))
    assert.ok(pdf.includes(Buffer.from('Davi'))); assert.ok(!pdf.includes(Buffer.from('Gustavo')))
    const excelDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Baixar Excel do fechamento', exact: true }).click()
    const exported = XLSX.utils.sheet_to_json(XLSX.read(await readFile(await (await excelDownload).path()), { type: 'buffer' }).Sheets['Pagamento Detalhes'], { header: 1 })
    assert.deepEqual(exported.slice(2).map(row => [row[3],row[5],row[6]]), [['Davi',70,.25],['Gustavo',30,.5]])
    await page.goto('http://127.0.0.1:5173/financeiro/notas-fiscais')
    await page.getByLabel('Quinzena', { exact: true }).selectOption('40. 1Q DE OUTUBRO')
    await page.getByRole('cell', { name: 'Davi', exact: true }).waitFor()
    await page.getByRole('cell', { name: 'Gustavo', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Gerar link', exact: true }).count(), 0)
    assert.equal(await page.getByRole('cell', { name: 'Pendente', exact: true }).count(), 2)
    Object.assign(tables, previousTables); paymentRequests.length = previousPayments
    console.log('PASS: dated inactive owner receives old closing; transition requires exact package/loss allocation, cancel and stale data write nothing, next fortnight selects successor; PDF/Excel/NF preserve both identities')
  }

  const oldestPeriod = { id: 'oldest', label: '01. 1Q DE ABRIL', partner, net_amount: 100, is_active: true }
  const latestPeriod = { id: 'latest', label: '33. 1Q DE AGOSTO', partner, net_amount: 200, is_active: true }
  tables.financial_periods = [oldestPeriod, latestPeriod, { id: 'middle9', label: '09. 1Q DE AGOSTO', partner, net_amount: 90, is_active: true }, { id: 'middle10', label: '10. 2Q DE AGOSTO', partner, net_amount: 100, is_active: true }]
  tables.financial_payment_history = []; tables.financial_drop_items = []; tables.financial_views = []
  tables.loss_events = [
    { id: 'loss1', financial_period_id: 'latest', drop_name_snapshot: 'DROP ALFA', partner, waybill: 'WB-001', label_code: 'ETQ-ALFA', bag_code: 'SACA-A', status: 'D2D Missing', seller: 'Loja Árvore', received_at: '2026-09-15T12:00:00Z', amount: 10.5, observation: 'Conferência urgente', is_active: true },
    { id: 'loss2', financial_period_id: 'oldest', period_label: oldestPeriod.label, drop_name_snapshot: 'DROP BETA', partner, waybill: ' wb-001 ', label_code: 'ETQ-BETA', bag_code: 'SACA-B', status: 'PUDO Missing', seller: 'Loja Beta', received_at: '2026-09-14T12:00:00Z', amount: 20, observation: 'Aguardar análise', is_active: true },
    { id: 'loss3', financial_period_id: 'latest', drop_name_snapshot: 'DROP GAMA', partner: 'J&T EXPRESS LTDA', waybill: 'WB-UNICO', label_code: 'ETQ-GAMA', bag_code: 'SACA-C', status: 'Outro', seller: 'Loja Gama', received_at: null, amount: 30, observation: '', is_active: true },
    { id: 'loss4', financial_period_id: 'oldest', drop_name_snapshot: 'DROP DELTA', partner, waybill: null, amount: 0, is_active: true },
    { id: 'loss5', financial_period_id: 'oldest', drop_name_snapshot: 'DROP EPSILON', partner, waybill: '', amount: 0, is_active: true },
  ]
  const lossesSnapshot = structuredClone(tables.loss_events)
  const writesBeforeFilters = writes.length
  await page.goto('http://127.0.0.1:5173/financeiro/pagamento-total')
  await page.getByRole('cell', { name: latestPeriod.label, exact: true }).waitFor()
  const expectedPeriods = [latestPeriod.label, '10. 2Q DE AGOSTO', '09. 1Q DE AGOSTO', oldestPeriod.label]
  assert.deepEqual(await page.getByRole('combobox', { name: 'Período', exact: true }).locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean)), expectedPeriods)
  assert.deepEqual(await page.locator('.finance-visual-page tbody tr:not(.financial-totals) td:first-child strong').allTextContents(), expectedPeriods)
  assert.equal(await page.locator('.financial-net-column').count(), 6)
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await page.locator('thead .financial-net-column').scrollIntoViewIfNeeded()
    for (const cell of await page.locator('.financial-net-column').all()) assert.deepEqual(await cell.evaluate(element => { const style = getComputedStyle(element); return [style.borderLeftWidth, style.borderRightWidth, style.borderLeftStyle] }), ['2px', '2px', 'solid'])
    await page.screenshot({ path: `tmp/browser-tests/net-column-${viewport.width}.png` })
  }
  await page.goto('http://127.0.0.1:5173/financeiro/extravios')
  const lossRows = page.locator('.losses-table tbody tr').filter({ has: page.getByRole('button', { name: 'Editar', exact: true }) })
  await lossRows.nth(4).waitFor()
  assert.equal(await page.locator('.losses-table thead input[type="search"]').count(), 10)
  assert.equal(await page.locator('.duplicate-waybill').count(), 2)
  assert.equal(await page.getByText('Duplicado (2)', { exact: true }).count(), 2)
  assert.equal(await page.locator('.duplicate-waybill').first().evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 242, 189)')
  await page.getByRole('checkbox', { name: 'Somente Waybills duplicados', exact: true }).check()
  assert.equal(await lossRows.count(), 2)
  assert.match(await page.locator('.financial-loss-total').innerText(), /30,50/)
  await page.getByRole('combobox', { name: 'Período', exact: true }).selectOption(latestPeriod.label)
  assert.equal(await lossRows.count(), 1)
  assert.equal(await page.getByText('Duplicado (2)', { exact: true }).count(), 1)
  assert.match(await page.locator('.financial-loss-total').innerText(), /10,50/)
  await page.getByRole('button', { name: 'Limpar filtros', exact: true }).click()
  for (const [column, value] of [['Período', '33.'], ['Scan station / DROP', 'alfa'], ['Waybill nº', 'wb-001'], ['Código da etiqueta', 'etq-alfa'], ['Saca', 'saca-a'], ['Status', 'd2d'], ['Seller', 'arvore'], ['Recebimento', '15/09/2026'], ['Valor', '10,50'], ['Observações', 'conferencia']]) {
    await page.getByRole('searchbox', { name: `Filtrar ${column}`, exact: true }).fill(value)
    assert.equal(await lossRows.count(), column === 'Período' || column === 'Waybill nº' ? 2 : 1, column)
    await page.getByRole('button', { name: 'Limpar filtros', exact: true }).click()
    assert.equal(await lossRows.count(), 5)
  }
  await page.getByRole('searchbox', { name: 'Filtrar Recebimento', exact: true }).fill('2026-09-15')
  await page.getByRole('searchbox', { name: 'Filtrar Valor', exact: true }).fill('10.50')
  await page.getByRole('searchbox', { name: 'Filtrar Seller', exact: true }).fill('ARVORE')
  assert.equal(await lossRows.count(), 1)
  await page.getByRole('searchbox', { name: 'Filtrar Waybill nº', exact: true }).fill('INEXISTENTE')
  assert.equal(await lossRows.count(), 0)
  assert.match(await page.locator('.financial-loss-total').innerText(), /0,00/)
  await page.getByRole('button', { name: 'Limpar filtros', exact: true }).click()
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.getByRole('searchbox', { name: 'Filtrar Waybill nº', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: `tmp/browser-tests/loss-filters-${viewport.width}.png` })
    await page.getByRole('searchbox', { name: 'Filtrar Observações', exact: true }).scrollIntoViewIfNeeded()
    await page.getByRole('searchbox', { name: 'Filtrar Observações', exact: true }).fill('urgente')
    assert.equal(await lossRows.count(), 1)
    await page.getByRole('button', { name: 'Limpar filtros', exact: true }).click()
  }
  await page.emulateMedia({ colorScheme: 'dark' })
  assert.equal(await page.locator('.duplicate-waybill').first().evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(73, 59, 19)')
  await page.emulateMedia({ colorScheme: 'light' })
  assert.equal(writes.length, writesBeforeFilters)
  assert.deepEqual(tables.loss_events, lossesSnapshot)
  console.log('PASS: newest periods first, all ten loss columns filter, duplicate Waybills stay highlighted across filters and totals preserve every record')

  {
  tables.financial_periods.push({ id: 'old-jt', label: oldestPeriod.label, partner: 'J&T EXPRESS LTDA', net_amount: 50, is_active: true })
  tables.drops.push({ id: 'jt-edit', name: 'DROP EDITADO', partner: 'J&T EXPRESS LTDA', is_active: true, status: 'ATIVO' })
  Object.assign(tables.loss_events[0], { updated_at: '2026-09-15T12:00:00Z', legacy_id: 99, created_by: 'original-user', drop_id: 'original-drop' })
  await page.reload()
  await lossRows.nth(4).waitFor()
  const otherLosses = structuredClone(tables.loss_events.slice(1))
  const financialBeforeLossEdit = structuredClone({ periods: tables.financial_periods, history: tables.financial_payment_history, items: tables.financial_drop_items })
  const editor = page.getByRole('dialog')
  const editLoss = waybill => page.locator('.losses-table tbody tr').filter({ has: page.getByRole('cell', { name: waybill, exact: true }) }).getByRole('button', { name: 'Editar', exact: true }).click()
  await page.locator('.losses-table tbody tr').filter({ hasText: 'DROP ALFA' }).getByRole('button', { name: 'Editar', exact: true }).click()
  await editor.getByRole('heading', { name: 'Editar extravio', exact: true }).waitFor()
  assert.equal(await editor.locator('input, textarea').count(), 11)
  const originalReceived = tables.loss_events[0].received_at
  await editor.getByLabel('Observações', { exact: true }).fill('Somente observação')
  await editor.getByRole('button', { name: 'Salvar alterações', exact: true }).click()
  await editor.waitFor({ state: 'hidden' })
  assert.equal(tables.loss_events[0].received_at, originalReceived)
  assert.equal(tables.loss_events[0].drop_id, 'original-drop')
  await page.locator('.losses-table tbody tr').filter({ hasText: 'DROP ALFA' }).getByRole('button', { name: 'Editar', exact: true }).click()
  const changedLossFields = { 'Período': oldestPeriod.label, 'Parceiro': 'J&T EXPRESS LTDA', 'Scan station / DROP': 'DROP EDITADO', 'Waybill nº': 'WB-EDITADO', 'Código da etiqueta': 'ETQ-EDITADA', 'Saca': 'SACA-EDITADA', 'Status': 'D2D Missing - não cobrei', 'Seller': 'Loja Editada', 'Recebimento': '2026-09-16T17:20:30', 'Valor do extravio': '12.34', 'Observações': 'Todos os campos editados' }
  for (const [label, value] of Object.entries(changedLossFields)) await editor.getByLabel(label, { exact: true }).fill(value)
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    for (const input of await editor.locator('input, textarea').all()) {
      await input.scrollIntoViewIfNeeded()
      const fits = await input.evaluate(element => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && element.clientWidth >= 100 })
      assert.equal(fits, true)
    }
    await editor.getByLabel('Período', { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: `tmp/browser-tests/loss-editor-${viewport.width}.png` })
  }
  await editor.getByRole('button', { name: 'Salvar alterações', exact: true }).click()
  await editor.waitFor({ state: 'hidden' })
  const editedLoss = tables.loss_events.find(row => row.id === 'loss1')
  assert.equal(editedLoss.financial_period_id, 'old-jt'); assert.equal(editedLoss.drop_id, 'jt-edit')
  assert.equal(editedLoss.amount, 12.34); assert.equal(editedLoss.legacy_id, 99); assert.equal(editedLoss.created_by, 'original-user')
  assert.equal(editedLoss.is_active, true)
  assert.deepEqual(tables.loss_events.slice(1), otherLosses)
  assert.deepEqual({ periods: tables.financial_periods, history: tables.financial_payment_history, items: tables.financial_drop_items }, financialBeforeLossEdit)
  await page.reload()
  await editLoss('WB-EDITADO')
  for (const [label, value] of Object.entries(changedLossFields)) assert.equal(await editor.getByLabel(label, { exact: true }).inputValue(), value, label)
  editedLoss.updated_at = '2026-09-17T12:00:00Z'
  await editor.getByLabel('Observações', { exact: true }).fill('Não sobrescrever versão mais recente')
  await editor.getByRole('button', { name: 'Salvar alterações', exact: true }).click()
  await editor.getByRole('alert').filter({ hasText: 'O extravio foi alterado' }).waitFor()
  assert.equal(editedLoss.observation, 'Todos os campos editados')
  await editor.getByRole('button', { name: 'Cancelar', exact: true }).click()

  const beforeCreateLoss = tables.loss_events.length
  await page.getByRole('button', { name: 'Adicionar extravio', exact: true }).click()
  const newLossFields = { ...changedLossFields, 'Período': latestPeriod.label, 'Parceiro': partner, 'Scan station / DROP': 'DROP TESTE', 'Waybill nº': 'WB-001', 'Status': 'PUDO Missing', 'Recebimento': '', 'Valor do extravio': '0', 'Observações': 'Novo extravio' }
  for (const [label, value] of Object.entries(newLossFields)) await editor.getByLabel(label, { exact: true }).fill(value)
  await editor.getByLabel('Período', { exact: true }).fill('INEXISTENTE')
  const requestsBeforeInvalidLoss = lossRequests.length
  await editor.getByRole('button', { name: 'Salvar alterações', exact: true }).click()
  await editor.getByRole('alert').filter({ hasText: 'fechamento existente' }).waitFor()
  assert.equal(lossRequests.length, requestsBeforeInvalidLoss)
  await editor.getByLabel('Período', { exact: true }).fill(latestPeriod.label)
  rejectLossWrite = true
  await editor.getByRole('button', { name: 'Salvar alterações', exact: true }).click()
  await editor.getByRole('alert').filter({ hasText: 'Permissão negada no teste de extravios.' }).waitFor()
  assert.equal(tables.loss_events.length, beforeCreateLoss)
  for (const [label, value] of Object.entries(newLossFields)) assert.equal(await editor.getByLabel(label, { exact: true }).inputValue(), value, label)
  rejectLossWrite = false
  holdLossWrite = true
  const newLossRequest = page.waitForRequest(request => request.method() === 'POST' && request.url().includes('/rest/v1/loss_events'))
  await editor.getByRole('button', { name: 'Salvar alterações', exact: true }).click()
  await newLossRequest
  assert.equal(await editor.getByRole('button', { name: 'Salvando…', exact: true }).isDisabled(), true)
  await editor.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit() })
  assert.equal(pendingLossWrites.length, 1)
  assert.equal(lossRequests.at(-1).payload.id, lossRequests.at(-2).payload.id)
  holdLossWrite = false
  pendingLossWrites.splice(0).forEach(resolve => resolve())
  await editor.waitFor({ state: 'hidden' })
  await page.getByRole('status').filter({ hasText: 'Extravio adicionado.' }).waitFor()
  assert.equal(tables.loss_events.length, beforeCreateLoss + 1)
  const addedLoss = tables.loss_events.at(-1)
  assert.equal(addedLoss.financial_period_id, 'latest'); assert.equal(addedLoss.drop_id, 'drop1')
  assert.equal(addedLoss.amount, 0); assert.equal(addedLoss.received_at, null)
  await page.reload()
  await lossRows.nth(5).waitFor()
  assert.match(await page.locator('.financial-loss-total').innerText(), /62,34/)
  assert.equal(await page.getByText('Duplicado (2)', { exact: true }).count(), 2)
  await page.locator('.losses-table tbody tr').filter({ hasText: 'Novo extravio' }).getByRole('button', { name: 'Editar', exact: true }).click()
  for (const [label, value] of Object.entries(newLossFields)) assert.equal(await editor.getByLabel(label, { exact: true }).inputValue(), value, label)
  await editor.getByRole('button', { name: 'Cancelar', exact: true }).click()
  tables.user_profiles[0].role = 'operador'
  tables.user_module_permissions[0].financeiro_view = true
  tables.user_module_permissions[0].financeiro_manage = false
  await page.reload()
  await page.locator('.losses-table').waitFor()
  assert.equal(await page.getByRole('button', { name: 'Adicionar extravio', exact: true }).count(), 0)
  assert.equal(await page.locator('.losses-table').getByRole('button', { name: 'Editar', exact: true }).count(), 0)
  tables.user_profiles[0].role = 'admin'
  console.log('PASS: net-column separators, complete loss editing/creation, retained errors, timestamp/metadata preservation, stale-write rejection, one insert on repeat submit and read-only permissions')
  }

  {
    const batchRows = [1, 2, 3].map(index => ({ id: `bulk${index}`, financial_period_id: index === 3 ? 'oldest' : 'latest', partner, period_label: index === 3 ? oldestPeriod.label : latestPeriod.label, drop_name_snapshot: `BULK DROP ${index}`, waybill: `BULK-WB-${index}`, label_code: `ETQ-${index}`, bag_code: `SACA-${index}`, status: 'PUDO Missing', seller: `Loja ${index}`, amount: index * 10, observation: `Manter ${index}`, received_at: `2026-09-${18 - index}T12:00:00Z`, updated_at: `2026-09-${18 - index}T13:00:00Z`, is_active: true, legacy_id: index + 100 }))
    tables.loss_events = structuredClone(batchRows)
    await page.goto('http://127.0.0.1:5173/financeiro/extravios')
    const selectAll = page.getByRole('checkbox', { name: 'Selecionar todos os extravios filtrados', exact: true })
    const selectLoss = index => page.locator('.losses-table tbody tr').filter({ hasText: `BULK-WB-${index}` }).getByRole('checkbox')
    const batchDialog = page.getByRole('dialog', { name: 'Editar extravios em massa', exact: true })
    const batchButton = page.getByRole('button', { name: 'Editar selecionados', exact: true })
    await selectAll.waitFor()
    assert.equal(await batchButton.isDisabled(), true)
    await selectLoss(1).check()
    assert.equal(await selectAll.evaluate(element => element.indeterminate), true)
    await selectAll.check()
    assert.equal(await page.locator('.losses-table tbody input:checked').count(), 3)
    await page.getByRole('combobox', { name: 'Período', exact: true }).selectOption(latestPeriod.label)
    assert.equal(await page.locator('.losses-table tbody input:checked').count(), 2)
    await page.getByRole('button', { name: 'Limpar filtros', exact: true }).click()
    assert.equal(await selectLoss(3).isChecked(), false)
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await selectAll.scrollIntoViewIfNeeded()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await page.screenshot({ path: `tmp/browser-tests/loss-selection-${viewport.width}.png` })
    }
    await batchButton.click()
    assert.equal(await batchDialog.getByRole('button', { name: 'Aplicar em 2 extravios', exact: true }).isDisabled(), true)
    assert.equal(await batchDialog.getByRole('textbox', { name: 'Waybill nº', exact: true }).isDisabled(), true)
    const requestCountBeforeInvalid = lossRequests.length
    await batchDialog.getByRole('checkbox', { name: 'Alterar Período', exact: true }).check()
    await batchDialog.getByRole('combobox', { name: 'Período', exact: true }).fill('INEXISTENTE')
    await batchDialog.getByRole('checkbox', { name: /^Confirmo aplicar/ }).check()
    await batchDialog.getByRole('button', { name: 'Aplicar em 2 extravios', exact: true }).click()
    await batchDialog.getByRole('alert').filter({ hasText: 'fechamento existente' }).waitFor()
    assert.equal(lossRequests.length, requestCountBeforeInvalid)
    await batchDialog.getByRole('checkbox', { name: 'Alterar Período', exact: true }).uncheck()
    assert.equal(await batchDialog.getByRole('alert').count(), 0)
    await batchDialog.getByRole('checkbox', { name: 'Alterar Status', exact: true }).check()
    await batchDialog.getByRole('combobox', { name: 'Status', exact: true }).fill('D2D Missing - não cobrei')
    await batchDialog.getByRole('checkbox', { name: 'Alterar Observações', exact: true }).check()
    await batchDialog.getByRole('checkbox', { name: /^Confirmo aplicar/ }).check()
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      assert.equal(await batchDialog.evaluate(element => element.scrollWidth <= element.clientWidth), true)
      await batchDialog.getByRole('checkbox', { name: 'Alterar Status', exact: true }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: `tmp/browser-tests/loss-bulk-${viewport.width}.png` })
    }
    holdLossWrite = true
    const firstBulkRequest = page.waitForRequest(request => request.method() === 'PATCH' && request.url().includes('/rest/v1/loss_events'))
    await batchDialog.getByRole('button', { name: 'Aplicar em 2 extravios', exact: true }).click()
    await firstBulkRequest
    await batchDialog.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit() })
    assert.equal(pendingLossWrites.length, 1)
    assert.equal(lossRequests.length, requestCountBeforeInvalid + 1)
    holdLossWrite = false
    pendingLossWrites.splice(0).forEach(resolve => resolve())
    await batchDialog.getByRole('status').filter({ hasText: '2 de 2 gravações confirmadas.' }).waitFor()
    await batchDialog.getByRole('button', { name: 'Fechar', exact: true }).click()
    assert.equal(lossRequests.length, requestCountBeforeInvalid + 2)
    assert.deepEqual(lossRequests.slice(-2).map(request => request.payload), [{ status: 'D2D Missing - não cobrei', observation: null }, { status: 'D2D Missing - não cobrei', observation: null }])
    assert.deepEqual(tables.loss_events, batchRows.map((row, index) => index < 2 ? { ...row, status: 'D2D Missing - não cobrei', observation: null } : row))
    assert.equal(await page.locator('.losses-table tbody input:checked').count(), 0)
    await page.reload()
    await selectLoss(1).check(); await selectLoss(2).check()
    await batchButton.click()
    await batchDialog.getByRole('checkbox', { name: 'Alterar Valor do extravio', exact: true }).check()
    await batchDialog.getByRole('spinbutton', { name: 'Valor do extravio', exact: true }).fill('0')
    await batchDialog.getByRole('checkbox', { name: /^Confirmo aplicar/ }).check()
    tables.loss_events[1].updated_at = '2026-09-20T10:00:00Z'
    await batchDialog.getByRole('button', { name: 'Aplicar em 2 extravios', exact: true }).click()
    await batchDialog.getByRole('alert').filter({ hasText: '1 de 2 gravações confirmadas. Lote interrompido:' }).waitFor()
    assert.equal(tables.loss_events[0].amount, 0); assert.equal(tables.loss_events[1].amount, 20); assert.equal(tables.loss_events[2].amount, 30)
    assert.equal(await batchDialog.getByRole('button', { name: 'Aplicar em 2 extravios', exact: true }).isDisabled(), true)
    await batchDialog.getByRole('button', { name: 'Fechar', exact: true }).click()
    await selectAll.check(); await batchButton.click()
    await batchDialog.getByRole('checkbox', { name: 'Alterar Seller', exact: true }).check()
    await batchDialog.getByRole('textbox', { name: 'Seller', exact: true }).fill('Nova loja')
    await batchDialog.getByRole('checkbox', { name: /^Confirmo aplicar/ }).check()
    loseLossResponseId = 'bulk2'
    const requestsBeforeUncertain = lossRequests.length
    await batchDialog.getByRole('button', { name: 'Aplicar em 3 extravios', exact: true }).click()
    await batchDialog.getByRole('alert').filter({ hasText: '1 de 3 gravações confirmadas. Lote interrompido:' }).waitFor()
    assert.equal(lossRequests.length, requestsBeforeUncertain + 2)
    assert.equal(tables.loss_events[0].seller, 'Nova loja'); assert.equal(tables.loss_events[1].seller, 'Nova loja'); assert.equal(tables.loss_events[2].seller, 'Loja 3')
    loseLossResponseId = ''
    await batchDialog.getByRole('button', { name: 'Fechar', exact: true }).click()
    await selectLoss(3).check(); await batchButton.click()
    await batchDialog.getByRole('checkbox', { name: 'Alterar Seller', exact: true }).check()
    await batchDialog.getByRole('textbox', { name: 'Seller', exact: true }).fill('Bloqueado')
    await batchDialog.getByRole('checkbox', { name: /^Confirmo aplicar/ }).check()
    rejectLossWrite = true
    await batchDialog.getByRole('button', { name: 'Aplicar em 1 extravios', exact: true }).click()
    await batchDialog.getByRole('alert').filter({ hasText: '0 de 1 gravações confirmadas. Lote interrompido: Permissão negada' }).waitFor()
    assert.equal(tables.loss_events[2].seller, 'Loja 3')
    rejectLossWrite = false
    await batchDialog.getByRole('button', { name: 'Fechar', exact: true }).click()
    await selectLoss(3).check()
    await page.getByRole('button', { name: 'Limpar seleção', exact: true }).click()
    assert.equal(await selectLoss(3).isChecked(), false)
    await selectLoss(3).check()
    await page.getByRole('button', { name: 'Atualizar dados', exact: true }).click()
    await selectLoss(3).waitFor()
    assert.equal(await selectLoss(3).isChecked(), false)
    tables.user_profiles[0].role = 'operador'
    await page.reload()
    await page.locator('.losses-table').waitFor()
    assert.equal(await page.locator('.losses-table input[type="checkbox"]').count(), 0)
    assert.equal(await batchButton.count(), 0)
    tables.user_profiles[0].role = 'admin'
    console.log('PASS: bulk selection respects filters, unchecked fields survive, confirmation/double-submit guard, zero, version conflict, uncertain response and permissions')
  }

  {
    tables.loss_events = []
    tables.financial_drop_items = [
      { id: 'export1', financial_period_id: 'latest', drop_name_snapshot: 'DROP TESTE', quantity_packages: 10, unit_value: .13, reimbursement: .2, is_active: true },
      { id: 'export2', financial_period_id: 'latest', drop_name_snapshot: 'OUTRO DROP', quantity_packages: 20, unit_value: .15, reimbursement: 0, is_active: true },
      { id: 'export3', financial_period_id: 'oldest', drop_name_snapshot: 'DROP TESTE', quantity_packages: 30, unit_value: .2, reimbursement: 0, is_active: true },
      { id: 'export4', financial_period_id: 'old-jt', drop_name_snapshot: 'DROP EDITADO', quantity_packages: 40, unit_value: .3, reimbursement: 0, is_active: true },
    ]
    tables.drops[0].pix_key = '00123456789'
    tables.financial_drop_items.filter(row => row.drop_name_snapshot === 'DROP TESTE').forEach(row => { row.registration_snapshot = { version: 1, dropId: 'drop1', responsible: 'Eduardo', pix: '00123456789', email: 'eduardo@example.test' } })
    tables.financial_periods.find(row => row.id === 'latest').payment_date = '2026-09-17'
    const writesBeforeExport = writes.length
    await page.goto('http://127.0.0.1:5173/financeiro/pagamento-detalhes')
    const table = page.locator('.payment-details-table')
    await table.waitFor()
    const compareExport = async expectedCount => {
      const downloaded = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Baixar Excel do fechamento', exact: true }).click()
      const file = await downloaded
      assert.equal(file.suggestedFilename(), 'pagamento-detalhes.xlsx')
      const sheet = XLSX.read(await readFile(await file.path()), { type: 'buffer' }).Sheets['Pagamento Detalhes']
      const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
      assert.deepEqual(matrix[0], (await table.locator('thead th').allTextContents()).slice(0, -1))
      assert.equal(matrix.length, expectedCount + 2)
      const displayed = await table.locator('tbody tr:not(.financial-totals)').evaluateAll(rows => rows.map(row => [...row.querySelectorAll('td')].slice(0, -1).map(cell => cell.textContent.trim())))
      const asScreen = (value, index) => typeof value !== 'number' ? value : index === 5 ? value.toLocaleString('pt-BR') : value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
      assert.deepEqual(matrix.slice(2).map(row => row.map(asScreen)), displayed)
      const screenTotals = await table.locator('.financial-totals td').allTextContents()
      assert.equal(matrix[1][5].toLocaleString('pt-BR'), screenTotals[0])
      for (const [index, column] of [7, 8, 9, 10, 11, 12].entries()) assert.equal(asScreen(matrix[1][column], column), screenTotals[index + 2])
      return sheet
    }
    await compareExport(4)
    await page.getByRole('combobox', { name: 'Parceiro', exact: true }).selectOption(partner)
    await compareExport(3)
    await page.getByRole('combobox', { name: 'Período', exact: true }).selectOption(latestPeriod.label)
    await compareExport(2)
    await page.getByRole('combobox', { name: 'DROP', exact: true }).selectOption('DROP TESTE')
    const filteredSheet = await compareExport(1)
    assert.equal(filteredSheet.O3.v, '00123456789'); assert.equal(filteredSheet.O3.t, 's')
    assert.equal(filteredSheet.N3.v, '17/09/2026')
    const pdfDownload = page.waitForEvent('download')
    await table.getByRole('button', { name: 'Gerar PDF', exact: true }).click()
    assert.match((await pdfDownload).suggestedFilename(), /\.pdf$/)
    await page.getByRole('combobox', { name: 'Parceiro', exact: true }).selectOption('J&T EXPRESS LTDA')
    assert.equal(await page.getByRole('button', { name: 'Baixar Excel do fechamento', exact: true }).isDisabled(), true)
    assert.equal(writes.length, writesBeforeExport)
    console.log('PASS: actual Excel downloads match all screen columns, rows, totals and period/partner/DROP filters; literal PIX and individual PDF retained')
  }

  {
    await page.goto('http://127.0.0.1:5173/financeiro/pagamento-detalhes')
    await page.getByRole('combobox', { name: 'Parceiro', exact: true }).selectOption(partner)
    await page.getByRole('combobox', { name: 'Período', exact: true }).selectOption(latestPeriod.label)
    await page.getByRole('combobox', { name: 'DROP', exact: true }).selectOption('DROP TESTE')
    const table = page.locator('.payment-details-table')
    const originalLine = await table.locator('tbody tr:not(.financial-totals)').innerText()
    const before = structuredClone({ periods: tables.financial_periods, items: tables.financial_drop_items, losses: tables.loss_events, history: tables.financial_payment_history })
    await page.getByRole('button', { name: 'Adicionar pagamento', exact: true }).click()
    const editor = page.getByRole('dialog')
    assert.equal(await editor.getByLabel('Período', { exact: true }).inputValue(), 'latest')
    assert.equal(await editor.getByLabel('DROP', { exact: true }).inputValue(), 'drop1')
    assert.equal(await editor.getByLabel('Parceiro', { exact: true }).inputValue(), partner)
    await editor.getByLabel('CNPJ de referência', { exact: true }).selectOption('BELLY')
    await editor.getByLabel('Responsável', { exact: true }).fill('Pagamento proporcional')
    await editor.getByLabel('Total pacote', { exact: true }).fill('-1')
    await editor.locator('form').evaluate(form => { form.noValidate = true; form.requestSubmit() })
    await editor.getByRole('alert').filter({ hasText: 'inteiro positivo ou zero' }).waitFor()
    assert.equal(paymentRequests.length, 0)
    await editor.getByLabel('Total pacote', { exact: true }).fill('10')
    await editor.getByLabel('Valor acordado', { exact: true }).fill('0')
    assert.equal(await editor.getByLabel('Subtotal', { exact: true }).inputValue(), '0')
    await editor.getByLabel('Valor acordado', { exact: true }).fill('0.13')
    assert.equal(await editor.getByLabel('Subtotal', { exact: true }).inputValue(), '1.3')
    await editor.getByLabel('Subtotal', { exact: true }).fill('100')
    await editor.getByLabel('Extravio W2D', { exact: true }).fill('2')
    await editor.getByLabel('Extravio D2D', { exact: true }).fill('3')
    await editor.getByLabel('Reembolso iMile', { exact: true }).fill('2')
    assert.equal(await editor.getByLabel('Total a receber', { exact: true }).inputValue(), '97')
    await editor.getByLabel('Total a receber', { exact: true }).fill('47.50')
    await editor.getByLabel('PIX', { exact: true }).fill('00111222333')
    await editor.getByLabel('Data pagamento', { exact: true }).evaluate(input => { input.type = 'text' })
    await editor.getByLabel('Data pagamento', { exact: true }).fill('2026-02-30')
    await editor.getByRole('button', { name: 'Adicionar pagamento', exact: true }).click()
    await editor.getByRole('alert').filter({ hasText: 'data de pagamento válida' }).waitFor()
    assert.equal(paymentRequests.length, 0)
    await editor.getByLabel('Data pagamento', { exact: true }).evaluate(input => { input.type = 'date' })
    await editor.getByLabel('Data pagamento', { exact: true }).fill('2026-09-20')
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      assert.equal(await editor.evaluate(element => element.scrollWidth <= element.clientWidth), true)
      for (const input of await editor.locator('input, select').all()) {
        const fits = await input.evaluate(element => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth })
        assert.equal(fits, true)
      }
      await editor.getByLabel('Período', { exact: true }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: `tmp/browser-tests/payment-add-${viewport.width}.png` })
    }
    rejectPaymentWrite = true
    await editor.getByRole('button', { name: 'Adicionar pagamento', exact: true }).click()
    await editor.getByRole('alert').filter({ hasText: 'Permissão negada no teste de pagamento.' }).waitFor()
    assert.equal(await editor.getByLabel('Total a receber', { exact: true }).inputValue(), '47.50')
    assert.equal(tables.financial_payment_history.length, before.history.length)
    rejectPaymentWrite = false; holdPaymentWrite = true
    const requested = page.waitForRequest(request => request.method() === 'POST' && request.url().includes('/rest/v1/financial_payment_history'))
    await editor.getByRole('button', { name: 'Adicionar pagamento', exact: true }).click()
    await requested
    await editor.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit() })
    assert.equal(pendingPaymentWrites.length, 1)
    assert.equal(paymentRequests.at(-1).payload.id, paymentRequests.at(-2).payload.id)
    holdPaymentWrite = false; pendingPaymentWrites.splice(0).forEach(resolve => resolve())
    await editor.waitFor({ state: 'hidden' })
    await page.getByRole('status').filter({ hasText: 'Pagamento adicionado.' }).waitFor()
    assert.deepEqual({ periods: tables.financial_periods, items: tables.financial_drop_items, losses: tables.loss_events }, { periods: before.periods, items: before.items, losses: before.losses })
    assert.equal(tables.financial_payment_history.length, before.history.length + 1)
    const added = tables.financial_payment_history.at(-1)
    assert.equal(added.financial_period_id, 'latest'); assert.equal(added.drop_id, 'drop1')
    assert.equal(added.total_receivable, 47.5); assert.equal(added.paid_at, '2026-09-20T12:00:00-03:00')
    assert.equal(JSON.parse(added.observation).movidosClosing.manualEntry, true)
    assert.equal(JSON.parse(added.observation).movidosClosing.sourceItemId, undefined)
    assert.ok((await table.locator('tbody tr:not(.financial-totals)').allInnerTexts()).includes(originalLine))
    assert.match(await table.locator('.financial-totals').innerText(), /49,00/)
    const excel = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Baixar Excel do fechamento', exact: true }).click()
    const workbook = XLSX.read(await readFile(await (await excel).path()), { type: 'buffer' })
    const matrix = XLSX.utils.sheet_to_json(workbook.Sheets['Pagamento Detalhes'], { header: 1 })
    assert.equal(matrix.length, 4); assert.equal(matrix[1][12], 49)
    const exported = matrix.find(row => row[3] === 'Pagamento proporcional')
    assert.equal(exported[0], 'BELLY'); assert.equal(exported[12], 47.5); assert.equal(exported[14], '00111222333')
    await page.reload()
    await table.getByRole('cell', { name: 'Pagamento proporcional', exact: true }).waitFor()
    await table.locator('tr').filter({ has: page.getByRole('cell', { name: 'Pagamento proporcional', exact: true }) }).getByRole('button', { name: 'Editar', exact: true }).click()
    assert.equal(await editor.getByLabel('DROP', { exact: true }).inputValue(), 'drop1')
    assert.equal(await editor.getByLabel('CNPJ de referência', { exact: true }).inputValue(), 'BELLY')
    await editor.getByLabel('Total a receber', { exact: true }).fill('0')
    await editor.getByRole('button', { name: 'Salvar alterações', exact: true }).click()
    await editor.waitFor({ state: 'hidden' })
    assert.equal(added.total_receivable, 0)
    assert.equal(tables.financial_payment_history.length, before.history.length + 1)
    await page.getByRole('button', { name: 'Adicionar pagamento', exact: true }).click()
    await editor.getByLabel('Período', { exact: true }).selectOption('latest')
    await editor.getByLabel('DROP', { exact: true }).selectOption('drop1')
    losePaymentResponse = true
    await editor.getByRole('button', { name: 'Adicionar pagamento', exact: true }).click()
    await editor.getByRole('alert').waitFor()
    losePaymentResponse = false
    await editor.getByRole('button', { name: 'Adicionar pagamento', exact: true }).click()
    await editor.getByRole('alert').filter({ hasText: 'já pode ter sido salvo' }).waitFor()
    assert.equal(tables.financial_payment_history.length, before.history.length + 2)
    await editor.getByRole('button', { name: 'Cancelar', exact: true }).click()
    tables.user_profiles[0].role = 'operador'
    await page.reload(); await table.waitFor()
    assert.equal(await page.getByRole('button', { name: 'Adicionar pagamento', exact: true }).count(), 0)
    assert.equal(await table.getByRole('button', { name: 'Editar', exact: true }).count(), 0)
    tables.user_profiles[0].role = 'admin'
    console.log('PASS: proportional payment add/edit/reload/export, original rows and shared period preserved, numeric/date validation, zero, denied/uncertain writes, stable ID, double-submit guard, permissions and desktop/mobile layout')
  }

  {
    const snapshot=structuredClone(tables)
    tables.drops=[{id:'operation-drop',name:'DROP OPERACAO',responsible:'João',address:'Rua das Flores',address_number:'42',neighborhood:'Jardim São Paulo',postal_code:'08600-999',partner,status:'ATIVO',is_active:true,municipality:'Suzano',state:'SP',signed_at:'2026-09-01',latitude:-23.54,longitude:-46.31},{id:'inactive-drop',name:'DROP DESATIVADO',partner,status:'EXCLUIDO',is_active:false,municipality:'Suzano',latitude:-23.55,longitude:-46.30},{id:'frozen-drop',name:'DROP CONGELADO',partner,status:'CONGELADO',is_active:true,municipality:'Suzano',latitude:-23.56,longitude:-46.32}]
    await page.goto('http://127.0.0.1:5173/cadastros')
    await page.getByLabel('Busca',{exact:true}).waitFor()
    assert.equal(await page.getByLabel('Busca',{exact:true}).evaluate(element=>document.activeElement===element),true)
    await page.goto('http://127.0.0.1:5173/cadastros/novo?edit=operation-drop')
    await page.getByRole('textbox',{name:'Nome do Drop',exact:true}).waitFor()
    await page.getByLabel('Início da operação',{exact:true}).fill('2026-09-03')
    await page.getByLabel('Fim da operação',{exact:true}).fill('2026-10-01')
    await page.getByRole('button',{name:'Salvar e permanecer',exact:true}).click()
    await page.getByText('Cadastro salvo com sucesso.',{exact:true}).waitFor()
    assert.equal(tables.drops[0].operation_started_at,'2026-09-03');assert.equal(tables.drops[0].operation_ended_at,'2026-10-01')
    assert.equal(tables.drops[0].signed_at,'2026-09-01');assert.equal(tables.drops[0].status,'ATIVO')
    await page.reload();await page.getByLabel('Fim da operação',{exact:true}).waitFor()
    await page.waitForFunction(()=>document.querySelector('input[type="date"][value="2026-10-01"]'))
    await page.goto('http://127.0.0.1:5173/')
    await page.locator('.leaflet-interactive').nth(1).waitFor()
    assert.equal(await page.locator('.leaflet-interactive').count(),2)
    for(const term of ['operacao','joao','Flores 42','Jardim Sao Paulo','08600-999','Suzano SP ATIVO']){
      await page.getByLabel('Buscar no mapa',{exact:true}).fill(term)
      await page.waitForFunction(()=>document.querySelectorAll('.leaflet-interactive').length===1)
      assert.equal(await page.locator('.leaflet-interactive').getAttribute('fill'),'#d4a900')
    }
    await page.getByLabel('Buscar no mapa',{exact:true}).fill('inexistente')
    await page.waitForFunction(()=>document.querySelectorAll('.leaflet-interactive').length===0)
    await page.getByRole('button',{name:'Limpar mapa',exact:true}).click()
    assert.equal(await page.getByLabel('Buscar no mapa',{exact:true}).inputValue(),'')
    await page.getByLabel('Situação cadastral',{exact:true}).selectOption('enabled')
    await page.getByLabel('Status no mapa',{exact:true}).selectOption('ATIVO')
    await page.waitForFunction(()=>document.querySelectorAll('.leaflet-interactive').length===1)
    await page.getByLabel('Status no mapa',{exact:true}).selectOption('')
    await page.getByLabel('Situação cadastral',{exact:true}).selectOption('disabled')
    await page.waitForFunction(()=>document.querySelectorAll('.leaflet-interactive').length===1)
    await page.locator('.leaflet-interactive').click()
    await page.locator('.leaflet-popup-content').getByText('DROP DESATIVADO',{exact:true}).waitFor()
    for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
      await page.setViewportSize(viewport)
      const bounds=await page.getByLabel('Status no mapa',{exact:true}).evaluate(element=>({left:element.getBoundingClientRect().left,right:element.getBoundingClientRect().right,screen:innerWidth}))
      assert.ok(bounds.left>=0&&bounds.right<=bounds.screen+1,JSON.stringify(bounds))
      await page.locator('.map-card').screenshot({path:`tmp/browser-tests/map-filters-${viewport.width}.png`})
    }
    await page.getByRole('button',{name:'Limpar mapa',exact:true}).click()
    await page.waitForFunction(()=>document.querySelectorAll('.leaflet-interactive').length===3)

    tables.delivery_route_base=[{id:'route-test1',street:'Rua Um',neighborhood:'Centro',city:'Suzano',postal_code:'08600-000',zone:'LESTE',route:'1',is_active:true},{id:'route-test2',street:'Rua Dois',neighborhood:'Centro',city:'Suzano',postal_code:'08600-001',zone:'OESTE',route:'2',is_active:true}]
    tables.delivery_volumes=[]
    await page.goto('http://127.0.0.1:5173/rotas-entrega')
    await page.getByPlaceholder('Buscar CEP, bairro, cidade, zona, rota ou sequência').fill('LESTE')
    page.once('dialog',dialog=>dialog.dismiss())
    const beforeClear=writes.length
    await page.getByRole('button',{name:'Esvaziar CEPs filtrados',exact:true}).click()
    assert.equal(writes.length,beforeClear)
    page.once('dialog',dialog=>dialog.accept('Revisao autorizada dos CEPs'))
    await page.getByRole('button',{name:'Esvaziar CEPs filtrados',exact:true}).click()
    await page.getByRole('status').filter({hasText:'1 CEP(s) esvaziado(s)'}).waitFor()
    assert.equal(tables.delivery_route_base[0].postal_code,null);assert.equal(tables.delivery_route_base[1].postal_code,'08600-001')
    const routesWorkbook=XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(routesWorkbook,XLSX.utils.json_to_sheet([{Rua:'Rua Um',Bairro:'Centro',Cidade:'Suzano',CEP:'99999-000',Zona:'LESTE',Rota:'1'},{Rua:'Rua Nova',Bairro:'Centro',Cidade:'Suzano',CEP:'99999-001',Zona:'LESTE',Rota:'3'},{Rua:'Rua Nova',Bairro:'Centro',Cidade:'Suzano',CEP:'99999-002',Zona:'LESTE',Rota:'3'}]),'Rotas')
    await page.locator('.route-import input').setInputFiles({name:'rotas.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:XLSX.write(routesWorkbook,{type:'buffer',bookType:'xlsx'})})
    await page.getByRole('status').filter({hasText:'A planilha informa CEPs diferentes'}).waitFor()
    assert.equal(tables.delivery_route_base.length,2);assert.equal(tables.delivery_route_base[0].postal_code,null)
    routesWorkbook.Sheets.Rotas=XLSX.utils.json_to_sheet([{Rua:'Rua Um',Bairro:'Centro',Cidade:'Suzano',CEP:'99999-000',Zona:'LESTE',Rota:'1'},{Rua:'Rua Nova',Bairro:'Centro',Cidade:'Suzano',CEP:'99999-001',Zona:'LESTE',Rota:'3'},{Rua:'Rua Nova',Bairro:'Centro',Cidade:'Suzano',CEP:'99999-001',Zona:'LESTE',Rota:'3'}])
    page.once('dialog',dialog=>dialog.accept())
    await page.locator('.route-import input').setInputFiles({name:'rotas-corrigidas.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:XLSX.write(routesWorkbook,{type:'buffer',bookType:'xlsx'})})
    await page.getByRole('status').filter({hasText:'1 endereço(s) importado(s); 0 rota(s) atualizada(s); 1 CEP(s) vazio(s) preenchido(s); 1 duplicado(s) ignorado(s).'}).waitFor()
    assert.equal(tables.delivery_route_base.length,3)
    assert.equal(tables.delivery_route_base[0].postal_code,'99999-000');assert.equal(tables.delivery_route_base[1].postal_code,'08600-001')
    routesWorkbook.Sheets.Rotas=XLSX.utils.json_to_sheet([{Rua:'Rua Um',Bairro:'Centro',Cidade:'Suzano',CEP:'99999-000',Zona:'LESTE',Rota:'Fulano'}])
    const namedRouteFile={name:'rotas-com-nome.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:XLSX.write(routesWorkbook,{type:'buffer',bookType:'xlsx'})}
    const beforeRouteUpdate=writes.length
    page.once('dialog',dialog=>dialog.dismiss())
    await page.locator('.route-import input').setInputFiles(namedRouteFile)
    await page.getByRole('status').filter({hasText:'Importação cancelada. Nenhum endereço alterado.'}).waitFor()
    assert.equal(writes.length,beforeRouteUpdate)
    page.once('dialog',dialog=>dialog.accept())
    await page.locator('.route-import input').setInputFiles(namedRouteFile)
    await page.getByRole('status').filter({hasText:'1 rota(s) atualizada(s)'}).waitFor()
    assert.equal(tables.delivery_route_base.length,3)
    assert.equal(tables.delivery_route_base[0].route,'Fulano')
    assert.equal(tables.delivery_route_base[0].postal_code,'99999-000')
    await page.locator('.route-import input').setInputFiles(namedRouteFile)
    await page.getByRole('status').filter({hasText:'0 rota(s) atualizada(s); 0 CEP(s) vazio(s) preenchido(s); 1 duplicado(s) ignorado(s).'}).waitFor()
    assert.equal(writes.length,beforeRouteUpdate+1)

    tables.financial_views=[{id:'view-test',title:'35. 2Q DE SETEMBRO',is_active:true,notes:JSON.stringify({annotation:'Anterior',summary:{invoice:100}}),created_at:'2026-10-12'}]
    tables.financial_periods=[{id:'period-test',financial_view_id:'view-test',label:'35. 2Q DE SETEMBRO',partner,logistics_partner:partner,reference_cnpj:'MOVIDOS',net_amount:100,is_active:true}]
    tables.financial_drop_items=[{id:'item-test',financial_period_id:'period-test',drop_name_snapshot:'DROP OPERACAO',quantity_packages:10,unit_value:1,is_active:true}]
    tables.financial_payment_history=[];tables.loss_events=[]
    await page.goto('http://127.0.0.1:5173/financeiro')
    await page.locator('.view-select').selectOption('view-test')
    await page.getByLabel('Anotações desta view',{exact:true}).fill('Somente nesta quinzena')
    await page.getByRole('button',{name:'Salvar anotação da view',exact:true}).click()
    await page.getByText('Anotação salva nesta View.',{exact:true}).waitFor()
    assert.deepEqual(JSON.parse(tables.financial_views[0].notes),{annotation:'Somente nesta quinzena',summary:{invoice:100}})
    tables.financial_views[0].notes=JSON.stringify({annotation:'Alterada por outra pessoa',summary:{invoice:100}})
    await page.getByLabel('Anotações desta view',{exact:true}).fill('Tentativa antiga')
    await page.getByRole('button',{name:'Salvar anotação da view',exact:true}).click()
    await page.getByText('A anotação mudou. Atualize antes de salvar.',{exact:true}).waitFor()
    assert.equal(JSON.parse(tables.financial_views[0].notes).annotation,'Alterada por outra pessoa')
    await page.getByRole('button',{name:'Corrigir período',exact:true}).click()
    await page.getByLabel('Novo período',{exact:true}).fill('35. 1Q DE SETEMBRO')
    await page.getByLabel('Motivo',{exact:true}).fill('Periodo digitado incorretamente')
    await page.getByRole('button',{name:'Confirmar alteração',exact:true}).click()
    await page.getByText('Período corrigido sem reimportar valores.',{exact:true}).waitFor()
    assert.equal(tables.financial_periods[0].label,'35. 1Q DE SETEMBRO');assert.equal(tables.financial_periods[0].net_amount,100)
    await page.locator('.view-select').selectOption('view-test')
    await page.getByRole('button',{name:'Excluir view',exact:true}).click()
    await page.getByLabel('Motivo',{exact:true}).fill('Reimportar fechamento correto')
    await page.getByRole('button',{name:'Confirmar alteração',exact:true}).click()
    await page.getByText('View excluída dos totais. Histórico preservado.',{exact:true}).waitFor()
    assert.equal(tables.financial_drop_items.length,1);assert.equal(tables.financial_drop_items[0].is_active,false)
    for(const name of Object.keys(tables))delete tables[name]
    Object.assign(tables,snapshot)
    console.log('PASS: search autofocus, operation dates, map filters, selected CEP clearing, route deduplication, view notes CAS, rename and soft deletion')
  }

  await page.goto('http://127.0.0.1:5173/financeiro/cnab')
  const cnabWorkbook=XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(cnabWorkbook,XLSX.utils.aoa_to_sheet([['DROP','RESPONSAVEL','TOTAL DROP','PIX'],['DROP TESTE','Eduardo',10,'drop@example.com']]),'Pagamentos')
  await page.getByLabel('Anexar planilha Excel',{exact:true}).setInputFiles({name:'cnab-opcional.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:XLSX.write(cnabWorkbook,{type:'buffer',bookType:'xlsx'})})
  await page.getByRole('cell',{name:'DROP TESTE',exact:true}).waitFor()
  await page.getByLabel('Data padrão para pagamentos sem data',{exact:true}).fill('')
  await page.getByRole('button',{name:'Gerar arquivo CNAB',exact:true}).click()
  await page.getByRole('alert').filter({hasText:'Informe a data padrão'}).waitFor()
  await page.getByLabel('Data padrão para pagamentos sem data',{exact:true}).fill('2026-10-12')
  const optionalCnab=page.waitForEvent('download')
  await page.getByRole('button',{name:'Gerar arquivo CNAB',exact:true}).click()
  const cnabText=await readFile(await (await optionalCnab).path(),'utf8')
  assert.ok(cnabText.includes('12102026'))
  console.log('PASS: CNAB without date/document columns generates using corrected default date')

  await page.goto('http://127.0.0.1:5173/leitor-etiquetas')
  await page.getByRole('button', { name: 'Abrir leitura contínua sem pausa' }).click()
  for (let capture = 1; capture <= 5; capture++) {
    await page.getByRole('button', { name: `Capturar pacote #${capture}`, exact: true }).click()
  }
  await page.waitForFunction(() => document.querySelectorAll('.tag-reading').length === 3)
  assert.equal(activeReads, 3)
  assert.equal(await page.locator('.tag-queue').count(), 2)
  assert.equal(await page.getByRole('button', { name: 'Limpar fila da câmera' }).isDisabled(), true)
  allowReads = true
  await Promise.all(pendingReads.splice(0).map(finish => finish()))
  await page.waitForFunction(() => document.querySelectorAll('.batch-item-concluido').length === 5)
  assert.equal(maximumReads, 3)
  assert.equal(completedReads, 5)
  assert.equal(await page.getByText('Não salvo na pré-rota: Falha simulada de gravacao', { exact: true }).count(), 5)
  assert.equal(await page.getByRole('button', { name: 'Limpar fila da câmera' }).isEnabled(), true)
  await page.getByRole('button', { name: 'Fechar câmera', exact: true }).click()
  await page.setViewportSize({ width: 1280, height: 600 })
  await page.getByRole('button', { name: /^Financeiro/ }).click()
  const sidebar = await page.locator('.app > aside').evaluate(element => ({ client: element.clientHeight, scroll: element.scrollHeight, overflow: getComputedStyle(element).overflowY }))
  assert.ok(sidebar.scroll > sidebar.client && sidebar.overflow === 'auto', JSON.stringify(sidebar))
  await page.screenshot({ path: 'tmp/browser-tests/reader-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: 'tmp/browser-tests/reader-mobile.png', fullPage: true })
  console.log('PASS: five continuous captures, concurrency three, failed saves visible, sidebar scrolls')
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 932, height: 430 }, { width: 1024, height: 768 }]) {
    const mobileContext = await browser.newContext({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2, storageState: await context.storageState() })
    await mobileContext.route('**/*', mockRequests)
    const mobilePage = await mobileContext.newPage()
    mobilePage.on('pageerror', error => failures.push(error.message))
    const layoutBeforeReader = {}
    const previousLayout = async () => {
      const result = await mobilePage.waitForFunction(() => {
        const sidebarElement = document.querySelector('.app > aside'), contentElement = document.querySelector('.app > .content')
        if (!sidebarElement || !contentElement) return false
        const sidebar = sidebarElement.getBoundingClientRect(), content = contentElement.getBoundingClientRect()
        return { width: document.documentElement.clientWidth, sidebarWidth: sidebar.width, sidebarRight: sidebar.right, contentLeft: content.left, grid: getComputedStyle(document.querySelector('.app')).gridTemplateColumns, viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? null }
      })
      return result.jsonValue()
    }
    for (const pathname of ['/cadastros', '/financeiro/pagamento-total', '/']) {
      await mobilePage.goto(`http://127.0.0.1:5173${pathname}`)
      await mobilePage.locator(pathname === '/' ? '.metric-grid' : pathname === '/cadastros' ? '.cadastros-list-page' : '.finance-visual-page').waitFor()
      layoutBeforeReader[pathname] = await previousLayout()
      const layout = layoutBeforeReader[pathname]
      assert.equal(layout.viewport, 'width=980')
      assert.ok(layout.width >= 980 && layout.sidebarRight <= layout.contentLeft + 1, JSON.stringify({ pathname, layout }))
      if (pathname === '/') assert.ok(await mobilePage.locator('.metric-grid').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length > 1))
      await mobilePage.screenshot({ path: `tmp/browser-tests/restored-${pathname === '/' ? 'dashboard' : pathname.includes('financeiro') ? 'financial' : 'registrations'}-${viewport.width}.png` })
    }
    await mobilePage.getByRole('button', { name: 'Leitor de etiquetas', exact: true }).click()
    await mobilePage.getByRole('button', { name: 'Abrir leitura contínua sem pausa' }).waitFor()
    const geometry = await mobilePage.evaluate(() => {
      const sidebar = document.querySelector('.app > aside').getBoundingClientRect()
      const firstSection = document.querySelector('.label-grid').getBoundingClientRect()
      const activeButton = document.querySelector('.nav-label-reader').getBoundingClientRect()
      return { screen: innerWidth, document: document.documentElement.scrollWidth, sidebar: sidebar.height, firstSection: firstSection.top + scrollY, activeButton: activeButton.height, coarse: matchMedia('(pointer:coarse)').matches }
    })
    assert.equal(geometry.screen, viewport.width, JSON.stringify(geometry))
    assert.ok(geometry.coarse && geometry.document <= viewport.width + 1 && geometry.sidebar <= 140 && geometry.firstSection <= 180 && geometry.activeButton <= 64, JSON.stringify(geometry))
    await mobilePage.screenshot({ path: `tmp/browser-tests/reader-touch-${viewport.width}.png`, fullPage: true })
    await mobilePage.getByRole('button', { name: /^Financeiro/ }).click()
    const expandedMenuHeight = await mobilePage.locator('.app > aside').evaluate(element => element.getBoundingClientRect().height)
    assert.ok(expandedMenuHeight <= 140, `Expanded reader menu: ${expandedMenuHeight}`)
    await mobilePage.getByRole('button', { name: 'Abrir leitura contínua sem pausa' }).click()
    await mobilePage.getByRole('button', { name: 'Capturar pacote #1', exact: true }).waitFor()
    await mobilePage.waitForFunction(() => { const video = document.querySelector('video'); return video?.readyState >= 2 && video.videoWidth > 0 })
    const mobileVideo = await mobilePage.locator('video').evaluate(video => ({ width: video.videoWidth, height: video.videoHeight, ready: video.readyState }))
    assert.ok(mobileVideo.width > 0 && mobileVideo.height > 0 && mobileVideo.ready >= 2, JSON.stringify(mobileVideo))
    await mobilePage.getByRole('button', { name: 'Fechar câmera', exact: true }).click()
    await mobilePage.goBack()
    await mobilePage.locator('.metric-grid').waitFor()
    assert.deepEqual(await previousLayout(), layoutBeforeReader['/'])
    await mobilePage.goForward()
    await mobilePage.getByRole('button', { name: 'Abrir leitura contínua sem pausa' }).waitFor()
    assert.equal(await mobilePage.evaluate(() => innerWidth), viewport.width)
    await mobilePage.getByRole('button', { name: /^Cadastros/ }).click()
    await mobilePage.getByRole('button', { name: 'Ver cadastros Drop off', exact: true }).click()
    await mobilePage.locator('.cadastros-list-page').waitFor()
    assert.deepEqual(await previousLayout(), layoutBeforeReader['/cadastros'])
    await mobilePage.getByRole('button', { name: 'Pagamento Total', exact: true }).click()
    await mobilePage.locator('.finance-visual-page').waitFor()
    assert.deepEqual(await previousLayout(), layoutBeforeReader['/financeiro/pagamento-total'])
    await mobilePage.reload()
    await mobilePage.locator('.finance-visual-page').waitFor()
    assert.deepEqual(await previousLayout(), layoutBeforeReader['/financeiro/pagamento-total'])
    await mobileContext.close()
  }
  console.log('PASS: real mobile viewport and touch keep reader navigation compact in portrait/landscape/tablet, including expanded submenu; camera opens')
  console.log('PASS: dashboard, registrations and financial retain previous desktop-style mobile layout on direct access, after reader navigation, history back/forward and reload')
  }
  for (const nativeSize of [{width:360,height:640},{width:640,height:360}]) {
    const portraitContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,storageState:await context.storageState()})
    await portraitContext.route('**/*',mockRequests)
    await portraitContext.addInitScript(({user,jwt})=>{
      localStorage.setItem('sb-hcpvmahmiqipghceylle-auth-token',JSON.stringify({access_token:jwt,refresh_token:'local-only',token_type:'bearer',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,user}))
    },{user,jwt})
    await portraitContext.addInitScript(({width,height})=>{
      globalThis.orientationLocks=0
      screen.orientation.lock=async()=>{globalThis.orientationLocks++}
      navigator.mediaDevices.getUserMedia=async()=>{
        const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height
        const paint=canvas.getContext('2d');paint.fillStyle='#ff0000';paint.fillRect(0,0,width,height/2);paint.fillStyle='#00ff00';paint.fillRect(0,height/2,width,height/2)
        return canvas.captureStream(10)
      }
      const original=HTMLCanvasElement.prototype.toDataURL
      HTMLCanvasElement.prototype.toDataURL=function(...args){
        if(args[0]==='image/jpeg'){
          const context=this.getContext('2d');globalThis.rotatedCapture={width:this.width,height:this.height,top:[...context.getImageData(this.width/2,10,1,1).data],bottom:[...context.getImageData(this.width/2,this.height-10,1,1).data]}
        }
        return original.apply(this,args)
      }
    },nativeSize)
    const portraitPage=await portraitContext.newPage()
    await portraitPage.goto('http://127.0.0.1:5173/leitor-etiquetas')
    await portraitPage.getByRole('button',{name:'Abrir leitura contínua sem pausa',exact:true}).waitFor()
    const batchOrder=await portraitPage.locator('.label-reader').evaluate(element=>element.lastElementChild.classList.contains('label-batch'))
    assert.equal(batchOrder,true)
    await portraitPage.getByRole('button',{name:'Abrir leitura contínua sem pausa',exact:true}).click()
    await portraitPage.waitForFunction(height=>document.querySelector('video')?.videoHeight===height,nativeSize.height)
    assert.equal(await portraitPage.locator('video').evaluate(video=>getComputedStyle(video).transform),'none')
    await portraitPage.getByRole('button',{name:'Capturar pacote #1',exact:true}).click()
    const capture=await portraitPage.evaluate(()=>globalThis.rotatedCapture)
    assert.equal(capture.width,nativeSize.width);assert.equal(capture.height,Math.round(nativeSize.width*9/16))
    assert.equal(await portraitPage.evaluate(()=>globalThis.orientationLocks),0)
    assert.ok(capture.top.every((channel,index)=>Math.abs(channel-[255,0,0,255][index])<=3),JSON.stringify(capture.top))
    assert.ok(capture.bottom.every((channel,index)=>Math.abs(channel-[0,255,0,255][index])<=3),JSON.stringify(capture.bottom))
    await portraitPage.screenshot({path:`tmp/browser-tests/camera-upright-native-${nativeSize.width}.png`,fullPage:true})
    assert.equal(await portraitPage.locator('video').evaluate(video=>getComputedStyle(video).transform),'none')
    await portraitPage.getByRole('button',{name:'Fechar câmera',exact:true}).click()
    await portraitContext.close()
    console.log(`PASS: upright phone keeps native ${nativeSize.width}x${nativeSize.height} scene upright in landscape preview and JPEG, with matching crop and no screen lock`)
  }
  assert.deepEqual(failures, [])
  console.log(`PASS: ${writes.length} simulated writes; no production requests were allowed`)
} finally { await browser.close() }