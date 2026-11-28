import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import * as XLSX from 'xlsx'

const baseURL = process.env.CADASTROS_BASE_URL || 'http://127.0.0.1:5173'
const origin = new URL(baseURL).origin
const output = 'tmp/cadastros-tests'
await mkdir(output, { recursive: true })
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'cadastros@example.test', aud: 'authenticated' }
const jwt = ['header', Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'local-test'].join('.')
const partner = 'IMILE DELIVERY BRAZIL LTDA'
const target = {
  id: 'drop-target', legacy_id: 2000, status: 'ATIVO', is_active: true, registration_type: null,
  name: 'DROP FILTRO', partner, responsible: 'Ana "A", (Centro)\\', phone: '(11) 98765-4321',
  cnpj: '12.345.678/0001-90', address: 'Rua das Flores', address_number: '10', complement: 'Sala 2',
  neighborhood: 'Centro', municipality: 'Suzano', state: 'SP', postal_code: '01234-567', zone: 'LESTE',
  operation_started_at: null, operation_ended_at: null, updated_at: '2026-01-01T00:00:00.000Z',
}
const drops = [
  target,
  { ...target, id: 'drop-plain', legacy_id: 1999, registration_type: 'drop_off', phone: '11987654321', cnpj: '12345678000190', postal_code: '01234567' },
  { ...target, id: 'drop-inactive', legacy_id: 1998, status: 'EXCLUÍDO', is_active: false, deactivated_reason: 'Motivo anterior' },
  { ...target, id: 'last-mile', legacy_id: 1997, registration_type: 'last_mile' },
  { ...target, id: 'last-mile-inactive', legacy_id: 1996, registration_type: 'last_mile', status: 'EXCLUÍDO', is_active: false },
  ...Array.from({ length: 1001 }, (_, index) => ({ ...target, id: `other-${index}`, legacy_id: index + 1, name: `OUTRO ${index}`, partner: 'J&T EXPRESS LTDA', zone: 'SUL', municipality: 'Santos', phone: null, cnpj: null, postal_code: null, registration_type: 'drop_off' })),
]
const requests = [], writes = [], failures = [], external = []
let viewer = false, rejectReads = false
let rejectWriteId = '', loseWriteResponse = false
let revision = 0
let writeGate = null

function splitExpressions(expression) {
  assert.ok(expression.startsWith('(') && expression.endsWith(')'), expression)
  const parts = []
  let current = '', quoted = false, escaped = false
  for (const character of expression.slice(1, -1)) {
    if (escaped) { current += character; escaped = false; continue }
    if (character === '\\' && quoted) { current += character; escaped = true; continue }
    if (character === '"') quoted = !quoted
    if (character === ',' && !quoted) { parts.push(current); current = '' }
    else current += character
  }
  assert.ok(!quoted && !escaped, 'Unbalanced PostgREST quoting')
  parts.push(current)
  return parts
}

function likeRegex(pattern) {
  let source = ''
  const literal = character => character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]
    if (character === '\\' && index + 1 < pattern.length) source += literal(pattern[++index])
    else if (character === '*' || character === '%') source += '.*'
    else if (character === '_') source += '.'
    else source += literal(character)
  }
  return new RegExp(`^${source}$`, 'isu')
}

function condition(row, field, expression) {
  const separator = expression.indexOf('.')
  const operator = expression.slice(0, separator)
  const raw = expression.slice(separator + 1)
  const value = raw.startsWith('"') ? JSON.parse(raw) : raw
  if (operator === 'eq') return row[field] != null && String(row[field]) === value
  if (operator === 'is' && value === 'null') return row[field] == null
  if (operator === 'ilike') return row[field] != null && likeRegex(value).test(String(row[field]))
  if (operator === 'match') return row[field] != null && new RegExp(value).test(String(row[field]))
  throw new Error(`Unsupported mock condition: ${field}.${expression}`)
}

function matches(row, params) {
  return [...params].every(([field, expression]) => {
    if (['select', 'order', 'offset', 'limit'].includes(field)) return true
    if (field === 'or') return splitExpressions(expression).some(part => {
      const separator = part.indexOf('.')
      return condition(row, part.slice(0, separator), part.slice(separator + 1))
    })
    return condition(row, field, expression)
  })
}

async function mockRequests(route) {
  const request = route.request(), url = new URL(request.url())
  const json = (data, headers = {}) => route.fulfill({ contentType: 'application/json', headers: { 'access-control-expose-headers': 'content-range', ...headers }, body: JSON.stringify(data) })
  try {
    if (url.hostname.endsWith('supabase.co')) {
      if (url.pathname === '/auth/v1/user') return json(user)
      assert.ok(url.pathname.startsWith('/rest/v1/'), `Unexpected Supabase path: ${url.pathname}`)
      const table = url.pathname.split('/').at(-1)
      if (request.method() !== 'GET') {
        const payload = request.postDataJSON()
        assert.ok(!viewer && ((table === 'drops' && request.method() === 'PATCH') || (table === 'audit_logs' && request.method() === 'POST')), 'Unexpected write')
        writes.push({ table, payload })
        if (table === 'drops') {
          const matching = drops.filter(row => matches(row, url.searchParams))
          if (matching.some(row => row.id === rejectWriteId)) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ message: 'Datas de operacao sobrepostas' }) })
          matching.forEach(row => Object.assign(row, payload, { updated_at: `2026-11-27T00:00:${String(++revision).padStart(2, '0')}.000Z` }))
          if (writeGate) await writeGate
          if (loseWriteResponse) { loseWriteResponse = false; return route.abort('failed') }
          if (url.searchParams.has('select')) {
            if (!matching.length) return route.fulfill({ status: 406, contentType: 'application/json', body: JSON.stringify({ message: 'Cadastro alterado ou sem permissao', code: 'PGRST116' }) })
            return json(matching[0])
          }
        }
        return json(null)
      }
      if (table === 'user_profiles') return json({ ...user, full_name: 'Teste cadastros', role: viewer ? 'operator' : 'admin', is_active: true })
      if (table === 'user_module_permissions') return json({ user_id: user.id, cadastros_view: true })
      if (table !== 'drops') return json([])
      requests.push(url)
      if (rejectReads) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Falha simulada de leitura' }) })
      const filtered = drops.filter(row => matches(row, url.searchParams))
      filtered.sort(url.searchParams.get('order')?.startsWith('legacy_id')
        ? (left, right) => right.legacy_id - left.legacy_id || left.id.localeCompare(right.id)
        : (left, right) => left.id.localeCompare(right.id))
      const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || filtered.length)
      return json(filtered.slice(offset, offset + limit), { 'content-range': `${offset}-${Math.max(offset, offset + Math.min(limit, filtered.length - offset) - 1)}/${filtered.length}` })
    }
    if (url.origin === origin) {
      assert.ok(!url.pathname.startsWith('/api/'), `Unexpected API request: ${url.pathname}`)
      return route.continue()
    }
    external.push(`${url.origin}${url.pathname}`)
    return route.abort('blockedbyclient')
  } catch (error) {
    failures.push(error.message)
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: error.message }) })
  }
}

console.log('Cadastros: launching Edge with isolated mocks')
const browser = await chromium.launch({ channel: 'msedge', headless: true })
async function createContext(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, ...options })
  await context.addInitScript(({ user, jwt, origin }) => {
    if (location.origin !== origin) return
    localStorage.setItem('sb-hcpvmahmiqipghceylle-auth-token', JSON.stringify({ access_token: jwt, refresh_token: 'local-only', token_type: 'bearer', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, user }))
  }, { user, jwt, origin })
  await context.route('**/*', mockRequests)
  context.on('page', page => page.on('pageerror', error => failures.push(error.message)))
  return context
}

async function countIs(page, count) {
  const text = `${count.toLocaleString('pt-BR')} cadastro(s) encontrado(s)`
  try {
    await page.waitForFunction(expected => document.querySelector('.result-count')?.textContent === expected && document.querySelector('table')?.getAttribute('aria-busy') === 'false', text)
  } catch (error) {
    console.log('Cadastros diagnostic:', JSON.stringify({ expected: text, body: await page.locator('body').innerText(), failures, requests: requests.slice(-3).map(url => url.pathname + url.search) }))
    throw error
  }
}

async function excel(page, allStatuses, ids, kind = 'DROP') {
  const name = `Baixar ${kind} filtrados${allStatuses ? ' (todos os status)' : ''}`
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name, exact: true }).click()
  const download = await downloadPromise
  assert.equal(download.suggestedFilename(), `cadastros-${kind === 'DROP' ? 'drop' : 'last-mile'}-filtrados${allStatuses ? '-todos-status' : ''}.xlsx`)
  const file = `${output}/${download.suggestedFilename()}`
  await download.saveAs(file)
  const workbook = XLSX.read(await readFile(file), { type: 'buffer' })
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets.Cadastros)
  assert.deepEqual(rows.map(row => row.ID), ids)
  return rows
}

try {
  const context = await createContext(), page = await context.newPage()
  await page.goto(`${baseURL}/cadastros`, { waitUntil: 'domcontentloaded' })
  await countIs(page, 1003)
  console.log('Cadastros: initial list loaded; checking pagination and Excel')
  assert.equal(await page.getByLabel('Status', { exact: true }).inputValue(), 'ATIVO')
  assert.equal(await page.locator('tbody .cadastro-row').count(), 50)
  await page.getByRole('button', { name: 'Próxima', exact: true }).click()
  await page.getByText('Página 2 de 21', { exact: true }).waitFor()
  await countIs(page, 1003)
  assert.equal((await page.locator('tbody tr td:first-child').allTextContents())[0], '953')
  await excel(page, false, [2000, 1999, ...Array.from({ length: 1001 }, (_, index) => 1001 - index)])
  console.log('Cadastros: paginated Excel passed; checking all filter fields')
  assert.ok(requests.some(url => url.searchParams.get('select') === '*' && url.searchParams.get('offset') === '1000'))

  const textFilters = { 'Nome DROP': 'DROP FILTRO', 'Responsável': target.responsible, Telefone: '11987654321', CNPJ: '12345678000190', Logradouro: 'Flores', 'Número': '10', Complemento: 'Sala 2', Bairro: 'Centro', 'Município': 'Suzano', UF: 'sp', CEP: '01234567', ID: '2000' }
  for (const [label, value] of Object.entries(textFilters)) await page.getByLabel(label, { exact: true }).fill(value)
  await page.getByLabel('Parceiro', { exact: true }).selectOption(partner)
  await page.getByLabel('Zona', { exact: true }).selectOption('LESTE')
  await page.getByLabel('Busca', { exact: true }).fill('FILTRO')
  await countIs(page, 1)
  await page.getByText('Página 1 de 1', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('UF', { exact: true }).inputValue(), 'SP')
  await excel(page, false, [2000])
  await page.getByLabel('ID', { exact: true }).fill('')
  await countIs(page, 2)
  await excel(page, false, [2000, 1999])
  const allStatuses = await excel(page, true, [2000, 1999, 1998])
  assert.equal(allStatuses[2].Status, 'EXCLUÍDO')
  for (const [label, masked] of [['Telefone', target.phone], ['CNPJ', target.cnpj], ['CEP', target.postal_code]]) {
    await page.getByLabel(label, { exact: true }).fill(masked)
    await countIs(page, 2)
  }
  await page.getByLabel('Busca', { exact: true }).fill(target.responsible)
  await countIs(page, 2)
  await page.getByLabel('Busca', { exact: true }).fill('x"),registration_type.eq.last_mile,name.ilike.*\\')
  await countIs(page, 0)
  await page.getByRole('button', { name: 'Limpar filtros', exact: true }).click()
  await countIs(page, 1004)
  assert.equal(await page.getByLabel('Status', { exact: true }).inputValue(), '')
  for (const label of ['Busca', ...Object.keys(textFilters), 'Parceiro', 'Zona']) assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), '', label)
  await page.getByLabel('Busca', { exact: true }).fill('12.345.678/0001-90')
  await countIs(page, 3)
  await page.getByLabel('Status', { exact: true }).selectOption('ATIVO')
  await countIs(page, 2)
  await page.getByLabel('Nome DROP', { exact: true }).fill('INEXISTENTE')
  await page.getByLabel('Nome DROP', { exact: true }).fill('DROP FILTRO')
  await countIs(page, 2)
  await page.screenshot({ path: `${output}/filters-desktop.png`, fullPage: true })
  console.log('Cadastros: combined filters passed; checking Last Mile and permissions')

  await page.goto(`${baseURL}/cadastros/last-mile`, { waitUntil: 'domcontentloaded' })
  await countIs(page, 1)
  await page.getByLabel('Nome DROP', { exact: true }).fill('DROP FILTRO')
  await countIs(page, 1)
  await excel(page, false, [1997], 'Last Mile')
  await excel(page, true, [1997, 1996], 'Last Mile')
  await page.getByRole('button', { name: 'Limpar filtros', exact: true }).click()
  await countIs(page, 2)
  await page.getByRole('button', { name: 'Atualizar', exact: true }).click()
  await countIs(page, 2)
  rejectReads = true
  await page.getByRole('button', { name: 'Atualizar', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Falha simulada de leitura' }).waitFor()
  rejectReads = false
  await page.getByRole('button', { name: 'Atualizar', exact: true }).click()
  await countIs(page, 2)

  viewer = true
  const viewerContext = await createContext(), viewerPage = await viewerContext.newPage()
  await viewerPage.goto(`${baseURL}/cadastros`, { waitUntil: 'domcontentloaded' })
  await countIs(viewerPage, 1003)
  assert.equal(await viewerPage.locator('tbody .danger-action').count(), 0)
  assert.equal(await viewerPage.getByRole('button', { name: /Alterar datas em massa/ }).count(), 0)
  assert.equal(await viewerPage.getByLabel('Selecionar todos desta página').count(), 0)
  await viewerContext.close()
  viewer = false

  console.log('Cadastros: kind and permissions passed; checking mobile geometry')
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    const mobileContext = await createContext({ viewport, isMobile: true, hasTouch: true }), mobile = await mobileContext.newPage()
    await mobile.goto(`${baseURL}/cadastros`, { waitUntil: 'domcontentloaded' })
    await countIs(mobile, 1003)
    const geometry = await mobile.evaluate(() => ({
      width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
      viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content'),
      inputsFit: [...document.querySelectorAll('.cadastro-filter-grid input, .cadastro-filter-grid select, .toolbar button')].every(element => {
        const bounds = element.getBoundingClientRect()
        return bounds.left >= -1 && bounds.right <= document.documentElement.clientWidth + 1
      }),
      tableScroll: document.querySelector('.table-wrap').scrollWidth > document.querySelector('.table-wrap').clientWidth,
    }))
    assert.equal(geometry.viewport, 'width=980')
    assert.ok(Math.abs(geometry.width - 980) <= 1, 'Cadastros must preserve the shared desktop viewport on phones')
    assert.ok(geometry.scroll <= geometry.width + 1, JSON.stringify(geometry))
    assert.ok(geometry.inputsFit, JSON.stringify(geometry))
    assert.ok(geometry.tableScroll, 'Table must scroll inside its own viewport')
    await mobile.getByLabel('Nome DROP', { exact: true }).fill('DROP FILTRO')
    await countIs(mobile, 2)
    await mobile.screenshot({ path: `${output}/filters-mobile-${viewport.width}.png`, fullPage: true })
    await mobile.getByLabel('Selecionar todos desta página').check()
    await mobile.getByRole('button', { name: 'Alterar datas em massa (2)' }).click()
    await mobile.getByLabel('Início da operação', { exact: true }).fill('2026-03-01')
    const dialogGeometry = await mobile.getByRole('dialog').evaluate(element => {
      const bounds = element.getBoundingClientRect()
      return { left: bounds.left, right: bounds.right, width: document.documentElement.clientWidth, height: bounds.height, viewportHeight: innerHeight }
    })
    assert.ok(dialogGeometry.left >= 0 && dialogGeometry.right <= dialogGeometry.width && dialogGeometry.height <= dialogGeometry.viewportHeight, JSON.stringify(dialogGeometry))
    await mobile.screenshot({ path: `${output}/bulk-dates-mobile-${viewport.width}.png`, fullPage: true })
    await mobile.getByRole('button', { name: 'Cancelar', exact: true }).click()
    await mobile.getByRole('button', { name: 'Documentos', exact: true }).click()
    await mobile.waitForFunction(() => document.querySelector('meta[name="viewport"]')?.getAttribute('content') === 'width=980')
    assert.ok(Math.abs(await mobile.evaluate(() => document.documentElement.clientWidth) - 980) <= 1)
    await mobile.goBack({ waitUntil: 'domcontentloaded' })
    await mobile.getByLabel('Nome DROP', { exact: true }).fill('')
    await countIs(mobile, 1003)
    assert.equal(await mobile.locator('meta[name="viewport"]').getAttribute('content'), 'width=980')
    assert.ok(Math.abs(await mobile.evaluate(() => document.documentElement.clientWidth) - 980) <= 1)
    await mobileContext.close()
  }
  assert.deepEqual(writes, [])
  console.log('Cadastros: checking bulk operation dates with isolated writes')
  await page.goto(`${baseURL}/cadastros`, { waitUntil: 'domcontentloaded' })
  await countIs(page, 1003)
  await page.getByLabel('Selecionar cadastro 2000', { exact: true }).check()
  await page.getByRole('button', { name: 'Próxima', exact: true }).click()
  await page.getByText('Página 2 de 21', { exact: true }).waitFor()
  await countIs(page, 1003)
  assert.equal(await page.getByRole('button', { name: 'Alterar datas em massa (0)' }).isDisabled(), true)
  await page.getByLabel('Nome DROP', { exact: true }).fill('DROP FILTRO')
  await countIs(page, 2)
  const plain = drops.find(row => row.id === 'drop-plain')
  plain.operation_started_at = '2026-02-01'
  await page.getByRole('button', { name: 'Atualizar', exact: true }).click()
  await countIs(page, 2)
  const openBulk = async () => {
    await page.getByLabel('Selecionar todos desta página').check()
    await page.getByRole('button', { name: 'Alterar datas em massa (2)' }).click()
    await page.getByRole('dialog', { name: 'Alterar datas em massa' }).waitFor()
  }
  const confirmBulk = async () => {
    await page.getByRole('checkbox', { name: /Confirmo aplicar as datas/ }).check()
    await page.getByRole('button', { name: /Aplicar em \d+ cadastros/ }).click()
  }
  const closeBulk = async () => {
    await page.getByRole('button', { name: 'Fechar e atualizar lista' }).click()
    await countIs(page, 2)
    assert.equal(await page.getByRole('button', { name: 'Alterar datas em massa (0)' }).isDisabled(), true)
  }
  await openBulk()
  await page.getByLabel('Início da operação', { exact: true }).fill('2026-03-01')
  await page.getByLabel('Alterar fim da operação', { exact: true }).check()
  await page.getByLabel('Fim da operação', { exact: true }).fill('2026-03-31')
  assert.equal(await page.getByRole('button', { name: 'Aplicar em 2 cadastros' }).isDisabled(), true)
  assert.match(await page.getByRole('table', { name: 'Prévia das datas' }).innerText(), /01\/02\/2026 → 01\/02\/2026/)
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click()
  assert.deepEqual(writes, [])
  await openBulk()
  await page.getByLabel('Início da operação', { exact: true }).fill('2026-03-01')
  await page.getByLabel('Alterar fim da operação', { exact: true }).check()
  await page.getByLabel('Fim da operação', { exact: true }).fill('2026-03-31')
  let releaseWrite
  writeGate = new Promise(resolve => { releaseWrite = resolve })
  await confirmBulk()
  assert.equal(await page.getByLabel('Início da operação', { exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: 'Fechar e atualizar lista' }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: 'Salvando…', exact: true }).isDisabled(), true)
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('dialog').isVisible(), true)
  writeGate = null
  releaseWrite()
  await page.getByRole('status').filter({ hasText: '2 cadastro(s) atualizado(s) com sucesso' }).waitFor()
  assert.deepEqual(writes.map(write => write.payload), [
    { operation_started_at: '2026-03-01', operation_ended_at: '2026-03-31' },
    { operation_ended_at: '2026-03-31' },
  ])
  assert.equal(plain.operation_started_at, '2026-02-01')
  await closeBulk()
  await page.reload()
  await countIs(page, 1003)
  await page.getByLabel('Nome DROP', { exact: true }).fill('DROP FILTRO')
  await countIs(page, 2)
  assert.match(await page.locator('tbody .cadastro-row').first().innerText(), /01\/03\/2026/)

  await openBulk()
  await page.getByLabel('Início da operação', { exact: true }).fill('2026-04-01')
  await page.getByText('0 cadastro(s) serão alterados; 2 permanecerão iguais.', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Aplicar em 0 cadastros' }).isDisabled(), true)
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click()

  await openBulk()
  await page.getByLabel('Início da operação', { exact: true }).fill('2026-04-01')
  await page.getByLabel('Preencher somente datas vazias', { exact: true }).uncheck()
  await page.getByRole('alert').filter({ hasText: 'anterior ao início' }).waitFor()
  assert.equal(writes.length, 2)
  await page.getByLabel('Início da operação', { exact: true }).fill('2026-01-01')
  await page.getByRole('checkbox', { name: /Confirmo aplicar as datas/ }).check()
  await page.getByLabel('Início da operação', { exact: true }).fill('2026-01-02')
  assert.equal(await page.getByRole('checkbox', { name: /Confirmo aplicar as datas/ }).isChecked(), false)
  target.updated_at = '2026-11-27T01:00:00.000Z'
  await confirmBulk()
  await page.getByRole('alert').filter({ hasText: '0 de 2 gravações confirmadas' }).waitFor()
  assert.equal(target.operation_started_at, '2026-03-01')
  assert.equal(await page.getByRole('button', { name: 'Aplicar em 2 cadastros' }).isDisabled(), true)
  await closeBulk()

  await openBulk()
  await page.getByLabel('Início da operação', { exact: true }).fill('2026-01-01')
  await page.getByLabel('Preencher somente datas vazias', { exact: true }).uncheck()
  rejectWriteId = 'drop-plain'
  await confirmBulk()
  await page.getByRole('alert').filter({ hasText: '1 de 2 gravações confirmadas' }).waitFor()
  assert.equal(target.operation_started_at, '2026-01-01')
  assert.equal(plain.operation_started_at, '2026-02-01')
  assert.equal(target.operation_ended_at, '2026-03-31')
  rejectWriteId = ''
  await closeBulk()

  await openBulk()
  await page.getByLabel('Início da operação', { exact: true }).fill('2026-01-15')
  await page.getByLabel('Preencher somente datas vazias', { exact: true }).uncheck()
  loseWriteResponse = true
  const beforeLost = writes.length
  await confirmBulk()
  await page.getByRole('alert').filter({ hasText: 'a última tentativa pode ter sido gravada' }).waitFor()
  assert.equal(writes.length, beforeLost + 1, 'A lost response must not retry or continue the batch')
  assert.equal(target.operation_started_at, '2026-01-15')
  await closeBulk()
  assert.match(await page.locator('tbody .cadastro-row').first().innerText(), /15\/01\/2026/)
  await page.getByLabel('Selecionar cadastro 2000', { exact: true }).check()
  await page.getByLabel('ID', { exact: true }).fill('2000')
  await countIs(page, 1)
  assert.equal(await page.getByRole('button', { name: 'Alterar datas em massa (0)' }).isDisabled(), true)
  await context.close()
  assert.deepEqual(failures, [])
  assert.deepEqual(external, [])
  console.log(`PASS cadastros: filters, pagination, exports, permissions, desktop/mobile, bulk dates, preview, persistence, conflicts, partial failure and lost response; ${requests.length} mocked reads, ${writes.length} mocked writes, no real network`)
} finally {
  await browser.close()
}