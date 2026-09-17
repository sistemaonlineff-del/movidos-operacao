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
  financial_drop_items: [{ id: 'item1', financial_period_id: 'p1', drop_name_snapshot: 'DROP TESTE', quantity_packages: 100, unit_value: .13, reimbursement: 0, is_active: true }],
  loss_events: [],
  email_templates: [{ key: 'financial_closing', subject: 'MODELO FINANCEIRO PRIVADO', body: 'CONTEUDO FINANCEIRO PRIVADO' }, { key: 'ready-message-initial', subject: 'Mensagem inicial', body: 'Atendimento publico' }],
  app_notes: [{ key: 'ready_messages_draft', content: 'Rascunho anterior' }],
  email_logs: [],
  drop_documents: [],
}
const photoBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1cAAAAASUVORK5CYII=', 'base64')
const storagePaths = new Set()
let serviceTemplatePath = ''
const writes = []
const failures = []
let rejectDropWrite = false
let unchangedDropWrite = false
let holdDropWrite = false
const pendingDropWrites = []
let rejectLossWrite = false
let rejectClosingWrite = false
let missingLogisticsColumn = false
let rejectClosingItems = false
let holdLossWrite = false
const pendingLossWrites = []
const lossRequests = []
let activeReads = 0
let maximumReads = 0
let completedReads = 0
let allowReads = false
const pendingReads = []
const mailRequests = []
let mailConfigured = true
let mailUncertain = false
let mailTestBlocked = false
let mailRetryUncertain = false
const testRetryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const labelResult = { extraction: { recipient: { street: 'Rua das Flores', neighborhood: 'Centro', city: 'Suzano', postalCode: '08600-000' }, warnings: [], uncertainFields: [] } }
await context.addInitScript(({ user, jwt }) => {
  localStorage.setItem('sb-hcpvmahmiqipghceylle-auth-token', JSON.stringify({ access_token: jwt, refresh_token: 'local-only', token_type: 'bearer', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, user }))
}, { user, jwt })
await context.route('**/*', async route => {
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
      return route.fulfill({ contentType: path.endsWith('.png') ? 'image/png' : 'application/pdf', body: path.endsWith('.png') ? photoBytes : Buffer.from('%PDF-1.7\nTest attachment\n%%EOF') })
    }
    if (!url.pathname.startsWith('/rest/v1/')) return json([])
    const table = url.pathname.split('/').pop()
    const source = tables[table] ?? []
    const filtered = source.filter(row => [...url.searchParams].every(([field, value]) => {
      if (value.startsWith('eq.')) return String(row[field]) === value.slice(3)
      if (value === 'is.null') return row[field] == null
      if (value.startsWith('in.(')) return value.slice(4, -1).split(',').includes(String(row[field]))
      if (value.startsWith('like.')) return String(row[field]).startsWith(value.slice(5).replace(/%$/, ''))
      return true
    }))
    let output = filtered
    if (table === 'financial_drop_items' && request.method() === 'POST' && rejectClosingItems) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: '22003', message: 'Valor fora do limite no teste.' }) })
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
    } else if (request.method() === 'PATCH') {
      const payload = request.postDataJSON()
      writes.push({ table, payload })
      output.forEach(row => Object.assign(row, payload))
    }
    return json(request.headers().accept?.includes('application/vnd.pgrst.object+json') ? output[0] ?? null : output)
  }
  if (url.origin === 'http://127.0.0.1:5173') {
    if (url.pathname === '/api/financial/send-closing') {
      if (!mailConfigured) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Conta remetente não configurada no teste.' }) })
      if (request.method() === 'GET') return json({ configured: true, from: 'sender@example.com' })
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
      if (request.method() === 'POST') {
        assert.equal(tables.user_profiles[0].role, 'admin')
        serviceTemplatePath = request.postDataJSON().serviceTemplatePath
      }
      return json({ serviceTemplatePath })
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
})
const page = await context.newPage()
page.on('pageerror', error => failures.push(error.message))
page.setDefaultTimeout(15000)
try {
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

  await page.goto('http://127.0.0.1:5173/financeiro/pagamento-detalhes')
  await page.getByRole('columnheader', { name: 'Responsável', exact: true }).waitFor()
  await page.getByRole('cell', { name: 'Eduardo', exact: true }).waitFor()
  await page.getByRole('cell', { name: partner, exact: true }).waitFor()
  await page.getByRole('cell', { name: 'MOVIDOS', exact: true }).waitFor()
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
  await page.getByLabel('Enviar modelo temporário', { exact: true }).setInputFiles({ name: 'modelo.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await readFile('public/templates/modelo-contrato-prestacao-servico.docx') })
  await page.getByText('Modelo temporário ativado. Os próximos contratos usarão esta versão.', { exact: true }).waitFor()
  assert.match(serviceTemplatePath, /^contract-templates\/service\//)
  await page.getByRole('button', { name: 'Restaurar modelo padrão', exact: true }).click()
  await page.getByText('Modelo padrão restaurado para os próximos contratos.', { exact: true }).waitFor()
  assert.equal(serviceTemplatePath, '')
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
  tables.user_profiles[0].role = 'admin'
  console.log('PASS: Last Mile photos/contracts persist under one ID, model edit is admin-only and finance viewer cannot edit totals')

  await page.goto('http://127.0.0.1:5173/financeiro')
  await page.getByLabel('Período do fechamento').fill('NOVO PERIODO')
  const templateDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Baixar modelo', exact: true }).click()
  const downloadedTemplate = await templateDownload
  assert.equal(downloadedTemplate.suggestedFilename(), 'modelo-fechamento-financeiro.xlsx')
  const downloadedWorkbook = XLSX.read(await readFile(await downloadedTemplate.path()), { type: 'buffer' })
  assert.deepEqual(XLSX.utils.sheet_to_json(downloadedWorkbook.Sheets['Pagamento Total'], { header: 1 })[0], ['Periodo', 'Parceiro', 'TotalLiquidoAReceber', 'DataPagamento'])
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
  assert.equal(await page.locator('.losses-table thead input').count(), 10)
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
  tables.drops.push({ id: 'jt-edit', name: 'DROP EDITADO', partner: 'J&T EXPRESS LTDA', is_active: true })
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
  assert.deepEqual(failures, [])
  console.log(`PASS: ${writes.length} simulated writes; no production requests were allowed`)
} finally { await browser.close() }