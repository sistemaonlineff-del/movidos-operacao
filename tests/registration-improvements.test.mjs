import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium } from 'playwright'

const origin = 'http://127.0.0.1:5173'
const supabaseOrigin = 'https://hcpvmahmiqipghceylle.supabase.co'
const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tmp/registration-improvements')
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'registration-test@example.test', aud: 'authenticated' }
const jwt = ['header', Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'local-test'].join('.')
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const postalResponses = {
  '00000001': { cep: '00000-001', logradouro: 'Rua Ficticia Alfa', bairro: 'Bairro Ficticio Alfa', localidade: 'Cidade Ficticia Alfa', uf: 'SP' },
  '00000002': { cep: '00000-002', logradouro: 'Rua Ficticia Beta', bairro: 'Bairro Ficticio Beta', localidade: 'Cidade Ficticia Beta', uf: 'RJ' },
}

function deferred() {
  let resolve
  const promise = new Promise(complete => { resolve = complete })
  return { promise, resolve }
}

function matches(row, params) {
  return [...params].every(([field, value]) => {
    if (['select', 'order', 'offset', 'limit'].includes(field)) return true
    if (field === 'or' && value === '(registration_type.is.null,registration_type.eq.drop_off)') return row.registration_type == null || row.registration_type === 'drop_off'
    if (value.startsWith('eq.')) return String(row[field]) === value.slice(3)
    if (value === 'is.null') return row[field] == null
    throw new Error(`Unsupported mock filter: ${field}=${value}`)
  })
}

async function fixture(browser, scenario, name, mobile = false) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block',
  })
  const state = { rows: [], writes: [], postal: [], blocked: [], mockErrors: [], pageErrors: [], continued: [], denied: false, loseFirstResponse: false, hold: null }
  await context.addInitScript(({ origin, user, jwt }) => {
    if (location.origin !== origin) return
    localStorage.setItem('sb-hcpvmahmiqipghceylle-auth-token', JSON.stringify({ access_token: jwt, refresh_token: 'local-only', token_type: 'bearer', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, user }))
  }, { origin, user, jwt })
  await context.routeWebSocket('**/*', socket => {
    const url = new URL(socket.url())
    if (url.origin === origin.replace('http:', 'ws:')) socket.connectToServer()
    else { state.blocked.push(`${url.origin}${url.pathname}`); socket.close() }
  })
  await context.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const json = (data, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': origin, 'access-control-expose-headers': 'content-range', ...headers }, body: JSON.stringify(data) })
    try {
      if (url.origin === supabaseOrigin) {
        if (request.method() === 'GET' && url.pathname === '/auth/v1/user') return json(user)
        assert.ok(url.pathname.startsWith('/rest/v1/'), `Unexpected mocked Supabase path: ${url.pathname}`)
        const table = url.pathname.slice('/rest/v1/'.length)
        const singular = request.headers().accept?.includes('application/vnd.pgrst.object+json')
        if (request.method() === 'GET') {
          if (table === 'user_profiles') return json({ ...user, full_name: 'Admin Ficticio', role: 'admin', is_active: true })
          if (table === 'user_module_permissions') return json({ user_id: user.id })
          assert.ok(['drops', 'drop_photos', 'drop_documents', 'mais_envios_registrations', 'mais_envios_stage_history'].includes(table), `Unexpected mocked table: ${table}`)
          const filtered = table === 'drops' ? state.rows.filter(row => matches(row, url.searchParams)) : []
          const offset = Number(url.searchParams.get('offset') || 0)
          const limit = Number(url.searchParams.get('limit') || filtered.length)
          const rows = filtered.slice(offset, offset + limit)
          return json(singular ? rows[0] ?? null : rows, 200, { 'content-range': rows.length ? `${offset}-${offset + rows.length - 1}/${filtered.length}` : `*/${filtered.length}` })
        }
        assert.equal(table, 'drops', 'Only registration writes are allowed')
        assert.ok(['POST', 'PATCH'].includes(request.method()), `Unexpected write method: ${request.method()}`)
        const payload = request.postDataJSON()
        assert.ok(payload && !Array.isArray(payload), 'Expected one registration per request')
        const write = { method: request.method(), payload, id: url.searchParams.get('id')?.replace(/^eq\./, ''), committed: false }
        state.writes.push(write)
        if (state.hold) await state.hold.promise
        if (state.denied) return json({ code: '42501', message: 'Permissao negada no teste de cadastro.' }, 403)
        let row
        if (write.method === 'POST') {
          const id = payload.id || randomUUID()
          if (state.rows.some(existing => existing.id === id)) return json({ code: '23505', message: 'duplicate key value violates unique constraint drops_pkey' }, 409)
          row = { is_active: true, registration_type: null, ...payload, id }
          state.rows.push(row)
        } else {
          const selected = state.rows.filter(existing => matches(existing, url.searchParams))
          assert.equal(selected.length, 1, 'PATCH must target exactly one existing UUID')
          row = selected[0]
          Object.assign(row, payload)
        }
        write.committed = true
        if (state.loseFirstResponse && write.method === 'POST') {
          state.loseFirstResponse = false
          return route.abort('failed')
        }
        return json(singular ? row : [row])
      }
      if (url.origin === 'https://viacep.com.br') {
        assert.equal(request.method(), 'GET')
        const match = /^\/ws\/(\d{8})\/json\/?$/.exec(url.pathname)
        assert.ok(match && postalResponses[match[1]], `Unexpected mocked CEP: ${url.pathname}`)
        state.postal.push(match[1])
        return json(postalResponses[match[1]])
      }
      if (url.origin === origin) {
        if (url.pathname === '/api/contract-templates') {
          assert.equal(request.method(), 'GET')
          return json({ serviceTemplatePath: '', terminationTemplatePath: '' })
        }
        assert.ok(!url.pathname.startsWith('/api/'), `Unexpected local API: ${url.pathname}`)
        assert.ok(['GET', 'HEAD'].includes(request.method()), `Unexpected local method: ${request.method()}`)
        state.continued.push(url.origin)
        return route.continue()
      }
      state.blocked.push(`${url.origin}${url.pathname}`)
      return route.abort('blockedbyclient')
    } catch (error) {
      state.mockErrors.push(error.message)
      return json({ message: error.message }, 500)
    }
  })
  const page = await context.newPage()
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => state.pageErrors.push(error.message))
  scenario.after(async () => {
    state.hold?.resolve()
    try {
      await page.screenshot({ path: path.join(output, `${name}-${mobile ? 'mobile' : 'desktop'}.png`), fullPage: true, animations: 'disabled', timeout: 15000 })
    } finally { await context.close() }
    assert.deepEqual(state.blocked, [], 'Non-allowlisted network requests were blocked')
    assert.deepEqual(state.mockErrors, [], 'Mock contract errors')
    assert.deepEqual(state.pageErrors, [], 'App runtime errors')
    assert.ok(state.continued.length > 0, 'The actual local App must load')
    assert.ok(state.continued.every(value => value === origin), 'No production requests may continue')
    console.log(`${name}: ${JSON.stringify({ writes: state.writes.map(({ method, payload, id, committed }) => ({ method, id: id || payload.id, committed })), rows: state.rows.length, postal: state.postal, blocked: state.blocked.length })}`)
  })
  return { page, state }
}

async function openDrop(page) {
  await page.goto(`${origin}/cadastros/novo`, { waitUntil: 'domcontentloaded' })
  await page.locator('.cadastro-form').waitFor()
  await page.locator('.cadastro-form').getByRole('heading', { name: 'Novo cadastro', exact: true }).waitFor()
}

function stayButton(page) {
  return page.getByRole('button', { name: 'Salvar e permanecer', exact: true })
}

async function saved(page) {
  await page.locator('.cadastro-form > p[role="status"]').filter({ hasText: 'Cadastro salvo com sucesso.' }).waitFor()
  await page.waitForURL(url => url.pathname === '/cadastros/novo' && uuidPattern.test(url.searchParams.get('edit') || ''))
  assert.equal(await stayButton(page).isEnabled(), true)
}

async function failed(page, message) {
  const alert = page.locator('.cadastro-form [role="alert"]')
  await alert.waitFor()
  assert.match(await alert.innerText(), message)
  assert.equal(await stayButton(page).isEnabled(), true)
  return alert.innerText()
}

function section(page, heading) {
  return page.locator('.cadastro-form .form-section').filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
}

async function addressIs(container, expected) {
  for (const [label, value] of Object.entries(expected)) {
    const control = label === 'UF' ? container.locator('label').filter({ hasText: /^\s*UF/ }).locator('select') : container.getByLabel(label, { exact: true })
    await control.evaluate((element, expectedValue) => {
      if (element.value.toUpperCase() !== expectedValue.toUpperCase()) throw new Error(`${element.labels?.[0]?.textContent}: expected ${expectedValue}, got ${element.value}`)
    }, value)
  }
}

await mkdir(output, { recursive: true })

test('Registration improvements: current App, isolated browser integration', async suite => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    await suite.test('Drop off: empty name, first stay POST and second stay PATCH use one UUID', async scenario => {
      const { page, state } = await fixture(browser, scenario, 'empty-name-stay')
      await openDrop(page)
      assert.equal(await page.getByLabel('Nome do Drop', { exact: true }).inputValue(), '')
      await stayButton(page).click()
      await saved(page)
      assert.equal(state.writes.length, 1, 'First stay must make exactly one request')
      assert.equal(state.writes[0].method, 'POST')
      assert.equal(state.writes[0].payload.name, '')
      const id = new URL(page.url()).searchParams.get('edit')
      assert.match(id, uuidPattern)
      assert.equal(state.writes[0].payload.id, id)
      assert.equal(state.rows.length, 1)
      await page.getByLabel('Nome do Drop', { exact: true }).fill('DROP FICTICIO ATUALIZADO')
      await stayButton(page).click()
      await saved(page)
      assert.deepEqual(state.writes.map(write => write.method), ['POST', 'PATCH'])
      assert.equal(state.writes[1].id, id)
      assert.equal(state.rows.length, 1)
      assert.equal(state.rows[0].id, id)
      assert.equal(state.rows[0].name, 'DROP FICTICIO ATUALIZADO')
      assert.equal(new URL(page.url()).searchParams.get('edit'), id)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.getByRole('heading', { name: 'Editar cadastro', exact: true }).waitFor()
      assert.equal(await page.getByLabel('Nome do Drop', { exact: true }).inputValue(), 'DROP FICTICIO ATUALIZADO')
    })

    await suite.test('Drop off: permission failure retains the form and allows a controlled retry', async scenario => {
      const { page, state } = await fixture(browser, scenario, 'permission-error')
      await openDrop(page)
      await page.getByLabel('Nome do Drop', { exact: true }).fill('DROP FICTICIO PERMISSAO')
      state.denied = true
      await stayButton(page).click()
      await failed(page, /Permissao negada no teste de cadastro\./)
      assert.equal(state.rows.length, 0)
      assert.equal(new URL(page.url()).search, '')
      assert.equal(await page.getByLabel('Nome do Drop', { exact: true }).inputValue(), 'DROP FICTICIO PERMISSAO')
      assert.equal(await page.locator('.cadastro-form > p[role="status"]').count(), 0)
      const id = state.writes[0].payload.id
      await page.screenshot({ path: path.join(output, 'permission-denied-desktop.png'), fullPage: true })
      state.denied = false
      await stayButton(page).click()
      await saved(page)
      assert.equal(state.rows.length, 1)
      assert.deepEqual(state.writes.map(write => write.payload.id), [id, id])
    })

    await suite.test('Drop off: simultaneous double click is protected while POST is pending', async scenario => {
      const { page, state } = await fixture(browser, scenario, 'double-click')
      await openDrop(page)
      state.hold = deferred()
      const requestReceived = page.waitForRequest(request => request.url().startsWith(`${supabaseOrigin}/rest/v1/drops`) && request.method() === 'POST')
      await stayButton(page).evaluate(button => { button.click(); button.click() })
      await requestReceived
      assert.equal(await stayButton(page).isDisabled(), true)
      await page.getByRole('button', { name: 'Salvando\u2026', exact: true }).waitFor()
      assert.equal(state.writes.length, 1, 'Double click must not queue a second write')
      await page.screenshot({ path: path.join(output, 'double-click-pending-desktop.png'), fullPage: true })
      state.hold.resolve()
      await saved(page)
      assert.equal(state.writes.length, 1)
      assert.equal(state.rows.length, 1)
    })

    await suite.test('Drop off: committed POST with lost response and retry cannot create another registration', async scenario => {
      const { page, state } = await fixture(browser, scenario, 'lost-response-retry')
      await openDrop(page)
      await page.getByLabel('Nome do Drop', { exact: true }).fill('DROP FICTICIO RESPOSTA PERDIDA')
      state.loseFirstResponse = true
      await stayButton(page).click()
      const firstError = await failed(page, /N\u00e3o foi poss\u00edvel salvar\./)
      assert.equal(state.rows.length, 1, 'The mock must commit BEFORE losing the response')
      assert.equal(state.writes.length, 1)
      assert.equal(state.writes[0].committed, true)
      const id = state.rows[0].id
      assert.match(state.writes[0].payload.id || '', uuidPattern, 'Client must reserve a UUID before the first POST')
      await page.screenshot({ path: path.join(output, 'lost-response-before-retry-desktop.png'), fullPage: true })
      await stayButton(page).click()
      await page.waitForFunction(() => {
        const button = document.querySelector('button[value="stay"]')
        return button && !button.disabled && document.querySelector('.cadastro-form > p[role="alert"], .cadastro-form > p[role="status"]')
      })
      assert.equal(state.rows.length, 1, 'REGRESSION: retry created another registration after the first POST committed')
      assert.equal(state.rows[0].id, id)
      assert.equal(state.writes.length, 2, 'Exactly one explicit retry is expected')
      for (const write of state.writes) assert.equal(write.method === 'POST' ? write.payload.id : write.id, id, 'Retry must reuse the original UUID')
      assert.equal(state.writes.filter(write => write.method === 'POST' && write.committed).length, 1)
      const retryMessage = await page.locator('.cadastro-form > p[role="alert"], .cadastro-form > p[role="status"]').innerText()
      assert.equal(retryMessage, 'Cadastro salvo com sucesso.')
      assert.equal(state.writes[1].method, 'PATCH')
      assert.equal(await page.getByLabel('Nome do Drop', { exact: true }).inputValue(), 'DROP FICTICIO RESPOSTA PERDIDA')
      console.log(`Lost response: first=${JSON.stringify(firstError)}; retry=${JSON.stringify(retryMessage)}; persisted=${state.rows.length}`)
    })

    await suite.test('CEP: eight digits fill both addresses and preserve previously entered fields', async scenario => {
      const { page, state } = await fixture(browser, scenario, 'postal-addresses')
      await openDrop(page)
      const location = section(page, 'Localiza\u00e7\u00e3o')
      const company = section(page, 'Endere\u00e7o do CNPJ')
      await location.getByLabel('CEP', { exact: true }).fill('00000001')
      await location.getByText('CEP localizado.', { exact: true }).waitFor()
      await addressIs(location, { Logradouro: 'Rua Ficticia Alfa', Bairro: 'Bairro Ficticio Alfa', 'Munic\u00edpio': 'Cidade Ficticia Alfa', UF: 'SP', CEP: '00000-001' })
      await company.getByLabel('CEP', { exact: true }).fill('00000002')
      await company.getByText('CEP localizado.', { exact: true }).waitFor()
      await addressIs(company, { Rua: 'Rua Ficticia Beta', Bairro: 'Bairro Ficticio Beta', Cidade: 'Cidade Ficticia Beta', UF: 'RJ', CEP: '00000-002' })
      await addressIs(location, { Logradouro: 'Rua Ficticia Alfa', UF: 'SP', CEP: '00000-001' })
      assert.deepEqual(state.postal, ['00000001', '00000002'])
      await location.getByLabel('Logradouro', { exact: true }).fill('RUA FICTICIA MANUAL')
      await location.getByLabel('Bairro', { exact: true }).fill('')
      await location.getByLabel('CEP', { exact: true }).fill('00000002')
      await location.getByText('Endere\u00e7o diferente do cadastro.', { exact: true }).waitFor()
      await addressIs(location, { Logradouro: 'RUA FICTICIA MANUAL', Bairro: 'Bairro Ficticio Beta', 'Munic\u00edpio': 'Cidade Ficticia Alfa', UF: 'SP' })
      await company.getByLabel('Rua', { exact: true }).fill('RUA CNPJ FICTICIA MANUAL')
      await company.getByLabel('Bairro', { exact: true }).fill('')
      await company.getByLabel('CEP', { exact: true }).fill('00000001')
      await company.getByText('Endere\u00e7o diferente do cadastro.', { exact: true }).waitFor()
      await addressIs(company, { Rua: 'RUA CNPJ FICTICIA MANUAL', Bairro: 'Bairro Ficticio Alfa', Cidade: 'Cidade Ficticia Beta', UF: 'RJ' })
      assert.deepEqual(state.postal, ['00000001', '00000002', '00000002', '00000001'])
      assert.equal(state.writes.length, 0)
    })

    for (const mobile of [false, true]) {
      await suite.test(`Menus: both groups, three types, Mais Envios list/form without errors (${mobile ? 'mobile' : 'desktop'})`, async scenario => {
        const { page, state } = await fixture(browser, scenario, 'navigation', mobile)
        if (mobile) {
          await page.goto(`${origin}/cadastros/mais-envios`, { waitUntil: 'domcontentloaded' })
          await page.getByText('Nenhum cadastro encontrado.', { exact: true }).waitFor()
          assert.equal(await page.locator('[role="alert"]').count(), 0)
          await page.screenshot({ path: path.join(output, 'mais-envios-list-mobile.png'), fullPage: true })
          await page.getByRole('button', { name: 'Novo cadastro', exact: true }).click()
          await page.waitForURL(`${origin}/cadastros/mais-envios/novo`)
          await page.getByRole('heading', { name: 'Novo Mais Envios', exact: true }).waitFor()
          assert.equal(await page.getByLabel('Smart (nome)', { exact: true }).isVisible(), true)
          assert.equal(await page.locator('[role="alert"]').count(), 0)
          await page.screenshot({ path: path.join(output, 'mais-envios-form-mobile.png'), fullPage: true })
        }
        await openDrop(page)
        const nav = page.locator('aside nav')
        const groups = [
          { label: /^Cadastros\s/, paths: ['/cadastros', '/cadastros/last-mile', '/cadastros/mais-envios'], surfaces: ['table', 'table', '.mais-envios .me-table'] },
          { label: /^Novo cadastro\s/, paths: ['/cadastros/novo', '/cadastros/last-mile/novo', '/cadastros/mais-envios/novo'], surfaces: ['.cadastro-form', '.last-mile-cadastro', '.mais-envios .me-form'] },
        ]
        for (const group of groups) {
          const parent = nav.getByRole('button', { name: group.label })
          const submenu = parent.locator('xpath=following-sibling::*[1][self::div]')
          assert.deepEqual(await submenu.locator('button').allTextContents(), ['Drop off', 'Last Mile', 'Mais Envios'])
          await parent.click()
          assert.equal(await submenu.count(), 0, 'Group must collapse')
          await parent.click()
          for (const [index, label] of ['Drop off', 'Last Mile', 'Mais Envios'].entries()) {
            const item = submenu.locator('button').filter({ hasText: new RegExp(`^${label}$`) })
            await item.waitFor({ state: 'visible' }).catch(error => {
              throw new Error(`${mobile ? 'Mobile 390px' : 'Desktop'}: ${group.label} > ${label} must be visible and usable`, { cause: error })
            })
            await submenu.getByRole('button', { name: label, exact: true }).click()
            await page.waitForURL(url => url.pathname === group.paths[index])
            await page.locator(group.surfaces[index]).waitFor()
            if (index === 2) {
              if (group.paths[index].endsWith('/novo')) {
                await page.getByRole('heading', { name: 'Novo Mais Envios', exact: true }).waitFor()
                assert.equal(await page.getByLabel('Smart (nome)', { exact: true }).isVisible(), true)
                assert.equal(await page.getByLabel('Status / etapa', { exact: true }).inputValue(), '1')
                assert.equal(await page.getByRole('button', { name: 'Salvar cadastro', exact: true }).isEnabled(), true)
              } else {
                await page.getByText('Nenhum cadastro encontrado.', { exact: true }).waitFor()
                assert.equal(await page.getByRole('region', { name: 'Cadastros Mais Envios', exact: true }).getAttribute('aria-busy'), 'false')
              }
              assert.equal(await page.locator('[role="alert"]').count(), 0)
              await page.screenshot({ path: path.join(output, `mais-envios-${group.paths[index].endsWith('/novo') ? 'form' : 'list'}-${mobile ? 'mobile' : 'desktop'}.png`), fullPage: true })
            }
          }
        }
        assert.equal(state.writes.length, 0)
      })
    }
  } finally {
    await browser.close()
    console.log(`Registration screenshots: ${output}`)
  }
})