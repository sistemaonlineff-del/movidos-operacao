import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { build, buildSync } from 'esbuild'
import { chromium } from 'playwright'

const compiled = buildSync({ entryPoints: ['src/postalCode.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
const { postalCodeDigits, formatPostalCode, lookupPostalCode, mergePostalAddress } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const empty = { street: '', neighborhood: '', city: '', state: '' }
const found = { street: 'Praca da Se', neighborhood: 'Se', city: 'Sao Paulo', state: 'SP' }
const via = { cep: '01001-000', logradouro: found.street, bairro: found.neighborhood, localidade: found.city, uf: 'SP', complemento: 'lado impar' }
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })

test('CEP formatting preserves leading zeroes, accepts paste and caps input at eight digits', () => {
  for (const [input, output] of [['', ''], ['01001', '01001'], ['010010', '01001-0'], ['CEP 01001-000', '01001-000'], ['0100100099', '01001-000']]) {
    assert.equal(formatPostalCode(input), output)
  }
  assert.equal(postalCodeDigits('01001-000'), '01001000')
})

test('lookup validates before fetch and requests only ViaCEP with an abort signal', async () => {
  let calls = 0
  const fetcher = async (url, options) => {
    calls++
    assert.equal(url, 'https://viacep.com.br/ws/01001000/json/')
    assert.ok(options.signal instanceof AbortSignal)
    assert.equal(options.credentials, 'omit')
    return json(via)
  }
  for (const invalid of ['', '1234567', '123456789']) await assert.rejects(lookupPostalCode(invalid, { fetcher }), { code: 'invalid' })
  assert.equal(calls, 0)
  assert.deepEqual(await lookupPostalCode('01001-000', { fetcher }), found)
  assert.equal(calls, 1)
})

test('not found is distinct from network, HTTP, malformed and mismatched responses', async () => {
  for (const erro of [true, 'true']) assert.equal(await lookupPostalCode('01001000', { fetcher: async () => json({ erro }) }), null)
  await assert.rejects(lookupPostalCode('01001000', { fetcher: async () => { throw new TypeError('offline') } }), { code: 'network' })
  await assert.rejects(lookupPostalCode('01001000', { fetcher: async () => new Response('', { status: 503 }) }), { code: 'network' })
  for (const payload of [null, [], {}, { ...via, cep: '99999-999' }, { ...via, uf: 'estado' }]) {
    await assert.rejects(lookupPostalCode('01001000', { fetcher: async () => json(payload) }), { code: 'response' })
  }
  await assert.rejects(lookupPostalCode('01001000', { fetcher: async () => new Response('invalid json') }), { code: 'response' })
})

test('general CEP omits unknown fields and does not erase existing address, number or complement', async () => {
  const general = await lookupPostalCode('01001000', { fetcher: async () => json({ localidade: found.city, uf: 'sp' }) })
  assert.deepEqual(general, { ...empty, city: found.city, state: 'SP' })
  const current = { ...found, street: 'Rua Particular, 45, fundos', number: '45', complement: 'fundos' }
  assert.deepEqual(mergePostalAddress(current, general, { overwrite: true }).address, current)
  assert.deepEqual(mergePostalAddress(empty, found).address, found)
})

test('different nonempty fields require explicit apply and equal fields retain original text', () => {
  const current = { ...empty, street: 'Rua Manual', city: 'Outra cidade', state: ' SP ' }
  const automatic = mergePostalAddress(current, found)
  assert.deepEqual(automatic.conflicts, ['street', 'city'])
  assert.deepEqual(automatic.address, { ...current, neighborhood: found.neighborhood })
  assert.deepEqual(mergePostalAddress(automatic.address, found, { overwrite: true }).address, { ...found, state: ' SP ' })
  assert.deepEqual(current, { ...empty, street: 'Rua Manual', city: 'Outra cidade', state: ' SP ' })
})

test('edits during lookup, including clearing or reverting a field, survive automatic and explicit application', () => {
  const initial = { ...empty, street: 'Rua Inicial', city: 'Inicial' }
  const current = { ...initial, street: '', city: 'Editada' }
  for (const overwrite of [false, true]) {
    const result = mergePostalAddress(current, found, { initial, overwrite, editedFields: new Set(['street', 'state']) })
    assert.deepEqual(result.address, { ...current, neighborhood: found.neighborhood })
    assert.deepEqual(result.conflicts, [])
  }
})

test('abort and timeout settle even if fetch or response body ignores cancellation', async () => {
  let signal
  const stalled = async (_url, options) => { signal = options.signal; return new Promise(() => {}) }
  const controller = new AbortController()
  const pending = lookupPostalCode('01001000', { fetcher: stalled, signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(signal.aborted, true)
  const before = new AbortController()
  before.abort()
  let called = false
  await assert.rejects(lookupPostalCode('01001000', { signal: before.signal, fetcher: async () => { called = true } }), { name: 'AbortError' })
  assert.equal(called, false)
  await assert.rejects(lookupPostalCode('01001000', { fetcher: stalled, timeoutMs: 15 }), { code: 'timeout' })
  assert.equal(signal.aborted, true)
  await assert.rejects(lookupPostalCode('01001000', { fetcher: async () => ({ ok: true, json: () => new Promise(() => {}) }), timeoutMs: 15 }), { code: 'timeout' })
  assert.deepEqual(await lookupPostalCode('01001000', { fetcher: async () => json(via) }), found)
})

test('controlled CEP component and both LastMile addresses work offline in the browser', async context => {
  const browserBundle = await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import { StrictMode, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { MemoryRouter } from 'react-router-dom';
      import PostalCodeLookup from './src/PostalCodeLookup';
      import LastMileCadastro from './src/LastMileCadastro';
      import './src/styles.css';
      function Harness() {
        const [value, setValue] = useState('');
        const [address, setAddress] = useState({ street: '', neighborhood: '', city: '', state: '' });
        const [number, setNumber] = useState('');
        const [complement, setComplement] = useState('');
        const [visible, setVisible] = useState(true);
        globalThis.__postalTest.setPostalCode = setValue;
        return <form className="cadastro-form" onSubmit={event => {
          event.preventDefault(); globalThis.__postalTest.writes.push({ value, address, number, complement });
        }}><div className="form-grid">
          {visible && <PostalCodeLookup value={value} onChange={setValue} address={address} onAddress={next => {
            globalThis.__postalTest.addressCalls.push(next); setAddress(next);
          }} />}
          {Object.keys(address).map(field => <label key={field}>{field}<input value={address[field]}
            onChange={event => setAddress(current => ({ ...current, [field]: event.target.value }))} /></label>)}
          <label>number<input value={number} onChange={event => setNumber(event.target.value)} /></label>
          <label>complement<input value={complement} onChange={event => setComplement(event.target.value)} /></label>
          <button type="button" onClick={() => setVisible(false)}>Unmount CEP</button>
          <button type="submit">Save</button>
        </div></form>;
      }
      createRoot(document.getElementById('root')).render(<StrictMode><MemoryRouter>
        {location.pathname === '/last-mile' ? <LastMileCadastro /> : <Harness />}
      </MemoryRouter></StrictMode>);
    ` },
    bundle: true, write: false, outdir: 'postal-memory', jsx: 'automatic', format: 'esm', platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'last-mile-offline', setup(builder) {
      builder.onResolve({ filter: /^\.\/(DropPhotos|DropDocuments|ContractTemplateManager|lib\/supabase)$/ }, args => ({ path: args.path, namespace: 'postal-mock' }))
      builder.onLoad({ filter: /.*/, namespace: 'postal-mock' }, args => ({ contents: args.path === './lib/supabase'
        ? `export const supabase = { from(table) {
            let payload, operation;
            const query = {
              insert(next) { payload = next; operation = 'insert'; return query; },
              update(next) { payload = next; operation = 'update'; return query; },
              eq() { return query; }, select() { return query; },
              async single() { globalThis.__postalTest.writes.push({ table, operation, payload });
                return { data: { id: 'local-last-mile' }, error: null }; }
            }; return query;
          } };`
        : 'export default function AttachmentPlaceholder() { return null; }' }))
    } }],
  })
  const javascript = browserBundle.outputFiles.find(file => file.path.endsWith('.js')).text
  const stylesheet = browserBundle.outputFiles.find(file => file.path.endsWith('.css')).text
  const server = createServer((request, response) => {
    if (request.url === '/bundle.js' || request.url === '/bundle.css') {
      response.setHeader('content-type', request.url.endsWith('.js') ? 'text/javascript' : 'text/css')
      response.end(request.url.endsWith('.js') ? javascript : stylesheet)
    } else {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end('<!doctype html><html lang="pt-BR"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script type="module" src="/bundle.js"></script></html>')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true })
    const session = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    await session.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
    await session.addInitScript(() => {
      const state = { requests: [], writes: [], addressCalls: [], shortTimeout: false }
      globalThis.__postalTest = state
      globalThis.fetch = (url, options) => {
        if (!/^https:\/\/viacep\.com\.br\/ws\/\d{8}\/json\/$/.test(String(url))) throw new Error('Unexpected fetch')
        return new Promise((resolve, reject) => state.requests.push({ url, signal: options.signal, resolve, reject }))
      }
      const nativeTimeout = globalThis.setTimeout.bind(globalThis)
      globalThis.setTimeout = (callback, delay, ...args) => nativeTimeout(callback, delay === 8000 && state.shortTimeout ? 30 : delay, ...args)
    })
    const page = await session.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    const open = async (path = '/') => {
      await page.goto(`${baseUrl}${path}`)
      await page.getByLabel('CEP', { exact: true }).first().waitFor()
    }
    const field = name => page.getByLabel(name, { exact: true })
    const count = expected => page.waitForFunction(expected => globalThis.__postalTest.requests.length === expected, expected)
    const respond = (index, data) => page.evaluate(({ index, data }) => {
      globalThis.__postalTest.requests[index].resolve(new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }))
    }, { index, data })
    const matches = expected => page.waitForFunction(expected => Object.entries(expected).every(([label, value]) => {
      const wrapper = [...document.querySelectorAll('label')].find(item => item.firstChild?.textContent === label)
      return wrapper?.querySelector('input')?.value === value
    }), expected)

    await context.test('debounce, formatted controlled input, empty-only fill and save while pending', async () => {
      await open()
      await field('number').fill('45')
      await field('complement').fill('fundos')
      await field('CEP').fill('01001')
      assert.equal(await page.evaluate(() => globalThis.__postalTest.requests.length), 0)
      await field('CEP').fill('01001000')
      await field('CEP').fill('01001001')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await count(1)
      assert.equal(await field('CEP').inputValue(), '01001-001')
      assert.match(await page.evaluate(() => globalThis.__postalTest.requests[0].url), /01001001/)
      await respond(0, { ...via, cep: '01001-001' })
      await matches(found)
      assert.equal(await field('number').inputValue(), '45')
      assert.equal(await field('complement').inputValue(), 'fundos')
      assert.equal(await page.evaluate(() => globalThis.__postalTest.writes.length), 1)
      assert.equal(await page.getByRole('button', { name: 'Aplicar endere\u00e7o', exact: true }).count(), 0)
    })

    await context.test('nonempty conflicts change only after the explicit apply button, never submitting', async () => {
      await open()
      await field('street').fill('Rua Manual, 45, fundos')
      await field('state').fill('RJ')
      await field('CEP').fill('01001000')
      await count(1)
      await respond(0, via)
      await matches({ ...found, street: 'Rua Manual, 45, fundos', state: 'RJ' })
      await page.getByRole('button', { name: 'Aplicar endere\u00e7o', exact: true }).click()
      await matches(found)
      assert.equal(await page.evaluate(() => globalThis.__postalTest.writes.length), 0)
    })

    await context.test('cleared, changed, reverted and post-response address edits survive apply', async () => {
      await open()
      await field('street').fill('Rua Inicial')
      await field('city').fill('Original')
      await field('state').fill('RJ')
      await field('CEP').fill('01001000')
      await count(1)
      await field('street').fill('')
      await field('city').fill('Temporaria')
      await field('city').fill('Original')
      await field('neighborhood').fill('Bairro editado')
      await field('number').fill('123')
      await field('complement').fill('sala 2')
      await respond(0, via)
      await page.getByRole('button', { name: 'Aplicar endere\u00e7o', exact: true }).waitFor()
      await matches({ street: '', city: 'Original', neighborhood: 'Bairro editado', state: 'RJ' })
      await field('city').fill('Depois da resposta')
      await page.getByRole('button', { name: 'Aplicar endere\u00e7o', exact: true }).click()
      await matches({ street: '', city: 'Depois da resposta', neighborhood: 'Bairro editado', state: 'SP', number: '123', complement: 'sala 2' })
    })

    await context.test('old responses cannot change a new, cleared or externally replaced CEP', async () => {
      await open()
      await field('CEP').fill('01001000')
      await count(1)
      await field('CEP').fill('20040002')
      await count(2)
      assert.equal(await page.evaluate(() => globalThis.__postalTest.requests[0].signal.aborted), true)
      await respond(1, { cep: '20040-002', logradouro: 'Rua Nova', localidade: 'Rio', uf: 'RJ' })
      await matches({ ...empty, street: 'Rua Nova', city: 'Rio', state: 'RJ' })
      await respond(0, via)
      await matches({ street: 'Rua Nova', city: 'Rio', state: 'RJ' })
      assert.equal(await field('CEP').inputValue(), '20040-002')
      await field('CEP').fill('30140071')
      await count(3)
      await page.evaluate(() => globalThis.__postalTest.setPostalCode(''))
      await respond(2, { localidade: 'Belo Horizonte', uf: 'MG' })
      await page.waitForFunction(() => document.querySelector('input[autocomplete="postal-code"]').value === '')
      await matches({ city: 'Rio', state: 'RJ' })
      assert.equal(await page.evaluate(() => globalThis.__postalTest.requests[2].signal.aborted), true)
    })

    await context.test('not found, network error, malformed response and general CEP allow retry and saving', async () => {
      await open()
      await field('street').fill('Rua Particular')
      await field('neighborhood').fill('Bairro Particular')
      await field('CEP').fill('01001000')
      await count(1)
      await respond(0, { erro: true })
      await page.getByText('CEP n\u00e3o encontrado.', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.getByRole('button', { name: 'Tentar novamente', exact: true }).click()
      await count(2)
      await page.evaluate(() => globalThis.__postalTest.requests[1].reject(new TypeError('offline')))
      await page.getByRole('alert').waitFor()
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.getByRole('button', { name: 'Tentar novamente', exact: true }).click()
      await count(3)
      await respond(2, {})
      await page.getByText('Resposta de CEP invalida. Tente novamente.', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Tentar novamente', exact: true }).click()
      await count(4)
      await respond(3, { localidade: found.city, uf: 'SP' })
      await matches({ ...found, street: 'Rua Particular', neighborhood: 'Bairro Particular' })
      assert.equal(await page.evaluate(() => globalThis.__postalTest.writes.length), 2)
    })

    await context.test('timeout is visible and retry succeeds; unmount cancels pending work', async () => {
      await open()
      await page.evaluate(() => { globalThis.__postalTest.shortTimeout = true })
      await field('CEP').fill('01001000')
      await count(1)
      await page.getByText('A consulta do CEP demorou demais. Tente novamente.', { exact: true }).waitFor()
      assert.equal(await page.evaluate(() => globalThis.__postalTest.requests[0].signal.aborted), true)
      await page.evaluate(() => { globalThis.__postalTest.shortTimeout = false })
      await page.getByRole('button', { name: 'Tentar novamente', exact: true }).click()
      await count(2)
      await respond(1, via)
      await matches(found)
      await field('CEP').fill('20040002')
      await count(3)
      const calls = await page.evaluate(() => globalThis.__postalTest.addressCalls.length)
      await page.getByRole('button', { name: 'Unmount CEP', exact: true }).click()
      await respond(2, { localidade: 'Rio', uf: 'RJ' })
      assert.equal(await page.evaluate(() => globalThis.__postalTest.requests[2].signal.aborted), true)
      assert.equal(await page.evaluate(() => globalThis.__postalTest.addressCalls.length), calls)
    })

    await context.test('LastMile addresses are independent, keep number/complement and save despite lookup failure', async () => {
      await open('/last-mile')
      const personal = page.locator('.form-section').filter({ has: page.getByRole('heading', { name: 'Endere\u00e7o e entregas', exact: true }) })
      const company = page.locator('.form-section').filter({ has: page.getByRole('heading', { name: 'Dados da empresa', exact: true }) })
      await field('Nome').fill('Pessoa Local')
      await personal.getByLabel('Endere\u00e7o', { exact: true }).fill('Rua Pessoal, 44, apto 5')
      await company.getByLabel('N\u00famero', { exact: true }).fill('94')
      await personal.getByLabel('CEP', { exact: true }).fill('01001000')
      await count(1)
      await company.getByLabel('CEP', { exact: true }).fill('20040002')
      await count(2)
      await respond(1, { cep: '20040-002', logradouro: 'Rua Empresa', bairro: 'Centro', localidade: 'Rio', uf: 'RJ', latitude: '-22', longitude: '-43' })
      await company.getByRole('button', { name: 'Aplicar endere\u00e7o', exact: true }).click()
      assert.equal(await company.getByLabel('Rua', { exact: true }).inputValue(), 'Rua Empresa')
      assert.equal(await company.getByLabel('UF', { exact: true }).inputValue(), 'RJ')
      assert.equal(await company.getByLabel('N\u00famero', { exact: true }).inputValue(), '94')
      assert.equal(await personal.getByLabel('Cidade', { exact: true }).inputValue(), '')
      await respond(0, { localidade: 'Sao Paulo', uf: 'SP' })
      await page.waitForFunction(() => [...document.querySelectorAll('input')].some(input => input.value === 'Sao Paulo'))
      assert.equal(await personal.getByLabel('Endere\u00e7o', { exact: true }).inputValue(), 'Rua Pessoal, 44, apto 5')
      await personal.getByLabel('CEP', { exact: true }).fill('99999999')
      await count(3)
      await respond(2, { erro: true })
      await personal.getByText('CEP n\u00e3o encontrado.', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Salvar cadastro Last Mile', exact: true }).click()
      await page.getByText('Cadastro Last Mile salvo. Agora voc\u00ea pode anexar fotos, contratos e distratos.', { exact: true }).waitFor()
      const writes = await page.evaluate(() => globalThis.__postalTest.writes)
      assert.equal(writes.length, 1)
      assert.equal(writes[0].operation, 'insert')
      assert.equal(writes[0].payload.address, 'Rua Pessoal, 44, apto 5')
      assert.equal(writes[0].payload.postal_code, '99999-999')
      assert.equal(writes[0].payload.company_postal_code, '20040-002')
      assert.equal(writes[0].payload.company_address, 'Rua Empresa')
      assert.equal(writes[0].payload.company_address_number, '94')
      assert.equal(writes[0].payload.company_state, 'RJ')
      assert.equal(writes[0].payload.partner, null)
      assert.equal(writes[0].payload.registration_type, 'last_mile')
      assert.equal('latitude' in writes[0].payload || 'longitude' in writes[0].payload, false)
      await page.getByRole('button', { name: 'Salvar altera\u00e7\u00f5es', exact: true }).click()
      await page.waitForFunction(() => globalThis.__postalTest.writes.length === 2)
      assert.equal(await page.evaluate(() => globalThis.__postalTest.writes[1].operation), 'update')
    })

    await context.test('CEP suggestions fit desktop and phone viewports with unique accessible labels', async () => {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 })
        await open()
        await field('street').fill('Rua Manual')
        await field('CEP').fill('01001000')
        await count(1)
        await respond(0, { ...via, logradouro: 'Avenida Com Um Nome Bastante Comprido Para Conferir A Quebra Do Endereco' })
        await page.getByRole('button', { name: 'Aplicar endere\u00e7o', exact: true }).waitFor()
        assert.equal(await field('CEP').getAttribute('inputmode'), 'numeric')
        const geometry = await page.locator('.postal-code-lookup').evaluate(element => {
          const bounds = element.getBoundingClientRect()
          return { width: bounds.width, viewport: innerWidth, overflow: element.scrollWidth > element.clientWidth + 1,
            clipped: [...element.querySelectorAll('input, button, p')].some(child => {
              const childBounds = child.getBoundingClientRect()
              return childBounds.left < bounds.left - 1 || childBounds.right > bounds.right + 1
            }) }
        })
        assert.ok(geometry.width <= geometry.viewport)
        assert.equal(geometry.overflow, false)
        assert.equal(geometry.clipped, false)
        assert.ok((await page.screenshot()).length > 1000)
      }
      await open('/last-mile')
      const ids = await page.getByLabel('CEP', { exact: true }).evaluateAll(inputs => inputs.map(input => input.id))
      assert.equal(new Set(ids).size, 2)
    })
    assert.deepEqual(errors, [])
    await session.close()
  } finally {
    if (browser) await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
})