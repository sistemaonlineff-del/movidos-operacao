import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import * as XLSX from 'xlsx'

await mkdir('tmp/browser-tests', { recursive: true })
await build({ entryPoints: ['src/closingSpreadsheet.ts'], outfile: 'tmp/browser-tests/closing.cjs', bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const { createClosingTemplate } = await import(pathToFileURL(`${process.cwd()}/tmp/browser-tests/closing.cjs`).href)
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
}
const writes = []
const failures = []
let activeReads = 0
let maximumReads = 0
let completedReads = 0
let allowReads = false
const pendingReads = []
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
    if (!url.pathname.startsWith('/rest/v1/')) return json([])
    const table = url.pathname.split('/').pop()
    const source = tables[table] ?? []
    const filtered = source.filter(row => [...url.searchParams].every(([field, value]) => {
      if (value.startsWith('eq.')) return String(row[field]) === value.slice(3)
      if (value.startsWith('like.')) return String(row[field]).startsWith(value.slice(5).replace(/%$/, ''))
      return true
    }))
    let output = filtered
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
    if (url.pathname === '/api/contract-templates') return route.fulfill({ contentType: 'text/html', body: '<html>Local preview</html>' })
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
  await page.locator('.cadastro-form').getByRole('button', { name: /^Salvar/ }).click()
  await page.waitForURL('**/cadastros')
  assert.equal(tables.drops[0].signed_at, '2026-09-02')
  assert.equal(tables.drops[0].terminated_at, '2026-09-15')
  assert.equal(tables.drops[0].termination_reason, 'Encerramento solicitado')
  console.log('PASS: PDFs use selected dates and termination reason; fields persist')

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