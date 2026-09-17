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
  const workbook = createClosingTemplate()
  workbook.Sheets.Fechamento = XLSX.utils.aoa_to_sheet([['Periodo', 'Parceiro', 'Drop', 'QuantidadePacote', 'CNPJReferencia'], ['', partner, 'DROP TESTE', 100, 'MOVIDOS']])
  workbook.Sheets['Pagamento Total'] = XLSX.utils.aoa_to_sheet([['Parceiro', 'TotalLiquidoAReceber', 'DataPagamento'], [partner, 999.99, 46280]])
  await page.locator('.finance-upload input[type="file"]').setInputFiles({ name: 'fechamento-teste.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) })
  await page.getByText('View de NOVO PERIODO importada com sucesso e consolidado geral atualizado.', { exact: true }).waitFor()
  const imported = tables.financial_periods.find(row => row.label === 'NOVO PERIODO')
  assert.equal(imported.net_amount, 999.99)
  assert.equal(imported.payment_date, '2026-09-15')
  console.log('PASS: uploaded closing stores net and payment date once per partner')

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