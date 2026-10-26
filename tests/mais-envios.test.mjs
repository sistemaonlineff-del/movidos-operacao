import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { PGlite } from '@electric-sql/pglite'
import { chromium } from 'playwright'

const helperBundle = await build({ entryPoints: ['src/maisEnviosData.ts'], bundle: true, write: false, format: 'esm', platform: 'node' })
const helpers = await import(`data:text/javascript;base64,${Buffer.from(helperBundle.outputFiles[0].text).toString('base64')}`)

test('Mais Envios: seis etapas, payload restrito e validacao antes de gravar', () => {
  assert.equal(helpers.MAIS_ENVIOS_STAGES.length, 6)
  const values = { ...helpers.emptyMaisEnvios(), smart: ' Smart teste ', cnpj: '12.345.678/0001-99', cep: '01001-000', uf: 'sp', id: 'forjado', created_by: 'forjado' }
  const payload = helpers.maisEnviosPayload(values)
  assert.equal(payload.smart, 'Smart teste')
  assert.equal(payload.cnpj, '12345678000199')
  assert.equal(payload.cep, '01001000')
  assert.equal(payload.uf, 'SP')
  assert.equal('id' in payload, false)
  assert.equal('created_by' in payload, false)
  for (const etapa of [0, 7, 1.5, NaN]) assert.throws(() => helpers.maisEnviosPayload({ ...values, etapa }), /etapa valida/)
  for (const invalid of [{ smart: '' }, { cnpj: '1' }, { cep: '1' }, { uf: 'Sao Paulo' }, { email: 'invalido' }]) {
    assert.throws(() => helpers.maisEnviosPayload({ ...values, ...invalid }))
  }
})

test('Mais Envios: busca literal escapa filtros e aceita CNPJ e CEP formatados', () => {
  assert.equal(helpers.maisEnviosSearch('  '), '')
  assert.match(helpers.maisEnviosSearch('12.345.678/0001-99'), /cnpj\.ilike\."%12345678000199%"/)
  assert.match(helpers.maisEnviosSearch('01001-000'), /cep\.ilike\."%01001000%"/)
  const malicious = helpers.maisEnviosSearch('a"),etapa.eq.6,%_*\\')
  assert.ok(malicious.startsWith('cnpj.ilike."%a\\"),etapa.eq.6,\\%\\_\\*\\\\%"'))
  assert.equal(helpers.maisEnviosSearch('word 123').includes('cnpj.ilike."%123%"'), false)
})

test('Mais Envios SQL: RLS, autoria, historico imutavel, isolamento e repeticao', async () => {
  const database = new PGlite()
  const user = '11111111-1111-4111-8111-111111111111'
  const other = '22222222-2222-4222-8222-222222222222'
  const registration = '33333333-3333-4333-8333-333333333333'
  const table = 'public.mais_envios_registrations'
  const history = 'public.mais_envios_stage_history'
  try {
    await database.exec(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql as $$select coalesce(nullif(current_setting('test.user',true),''),'${user}')::uuid$$;
      create function is_active_user() returns boolean language sql as $$select coalesce(current_setting('test.active',true),'yes')='yes'$$;
      create function has_module_permission(permission text) returns boolean language sql as $$select permission=any(string_to_array(current_setting('test.permissions',true),','))$$;
      grant usage on schema auth to anon,authenticated;
      create table drops(id integer primary key, name text); insert into drops values(1,'Financeiro preservado');
      alter table drops enable row level security; create policy preserved on drops for select using(true);
      create table financial_periods(id integer primary key, amount numeric); insert into financial_periods values(1,123.45);`)
    const before = (await database.query('select * from drops')).rows
    const finance = (await database.query('select * from financial_periods')).rows
    const migration = await readFile('supabase/migrations/20261023130000_mais_envios.sql', 'utf8')
    await database.exec(migration); await database.exec(migration)
    for (const name of ['mais_envios_registrations', 'mais_envios_stage_history']) {
      assert.equal((await database.query(`select relrowsecurity from pg_class where relname='${name}'`)).rows[0].relrowsecurity, true)
      for (const role of ['anon', 'authenticated']) for (const privilege of ['DELETE', 'TRUNCATE']) {
        assert.equal((await database.query(`select has_table_privilege('${role}','${name}','${privilege}') allowed`)).rows[0].allowed, false)
      }
    }
    await database.exec("set role authenticated; select set_config('test.permissions','cadastros_view,cadastros_create',false)")
    await database.exec(`insert into ${table}(id,smart,created_by,created_at) values('${registration}','Smart teste','${other}','2000-01-01') returning *`)
    const initial = (await database.query(`select *, updated_at::text as updated_at, created_at::text as created_at from ${table}`)).rows[0]
    assert.equal(initial.created_by, user)
    assert.notEqual(initial.created_at, '2000-01-01 00:00:00+00')
    assert.equal((await database.query(`select count(*) from ${history}`)).rows[0].count, 1)
    assert.equal((await database.query(`update ${table} set etapa=2 returning id`)).rows.length, 0)
    await database.exec("select set_config('test.permissions','cadastros_view,cadastros_edit',false)")
    await assert.rejects(database.exec(`insert into ${table}(smart) values('Negado')`), /row-level security/)
    await database.exec(`select set_config('test.user','${other}',false)`)
    await database.exec(`update ${table} set etapa=3, updated_at='2000-01-01' where id='${registration}' and updated_at='${initial.updated_at}' returning *`)
    const changed = (await database.query(`select *, updated_at::text as updated_at from ${table}`)).rows[0]
    assert.notEqual(changed.updated_at, initial.updated_at)
    assert.equal((await database.query(`update ${table} set etapa=4 where updated_at='${initial.updated_at}' returning id`)).rows.length, 0)
    await database.exec(`update ${table} set responsavel='Outro nome'`)
    const events = (await database.query(`select previous_stage,etapa,changed_by,changed_at from ${history} order by changed_at`)).rows
    assert.deepEqual(events.map(event => [event.previous_stage, event.etapa, event.changed_by]), [[null, 1, user], [1, 3, other]])
    assert.ok(events.every(event => event.changed_at))
    for (const assignment of [`id='${other}'`, `created_by='${other}'`, "created_at='2000-01-01'"]) {
      await assert.rejects(database.exec(`update ${table} set ${assignment}`), /imutaveis/)
    }
    await assert.rejects(database.exec(`update ${table} set etapa=7`), /check constraint/)
    await assert.rejects(database.exec(`update ${table} set cnpj='123'`), /check constraint/)
    await assert.rejects(database.exec(`update ${history} set etapa=6`), /permission denied/)
    await assert.rejects(database.exec(`insert into ${history}(registration_id,etapa,changed_by) values('${registration}',6,'${user}')`), /permission denied/)
    await assert.rejects(database.exec(`delete from ${table}`), /permission denied/)
    await database.exec("select set_config('test.active','no',false)")
    assert.equal((await database.query(`select * from ${table}`)).rows.length, 0)
    assert.equal((await database.query(`select * from ${history}`)).rows.length, 0)
    assert.equal((await database.query(`update ${table} set etapa=6 returning id`)).rows.length, 0)
    await database.exec("select set_config('test.permissions','cadastros_view,cadastros_create,cadastros_edit',false)")
    await assert.rejects(database.exec(`insert into ${table}(smart) values('Inativo')`), /row-level security/)
    await database.exec("select set_config('test.active','yes',false); select set_config('test.permissions','cadastros_edit,cadastros_create',false)")
    assert.equal((await database.query(`select * from ${table}`)).rows.length, 0)
    await assert.rejects(database.exec(`insert into ${table}(smart) values('Sem leitura')`), /row-level security/)
    await database.exec('reset role; set role anon')
    await assert.rejects(database.exec(`select * from ${table}`), /permission denied/)
    await assert.rejects(database.exec(`select * from ${history}`), /permission denied/)
    await database.exec('reset role')
    await assert.rejects(database.exec(`update ${history} set etapa=6`), /imutavel/)
    await assert.rejects(database.exec(`delete from ${history}`), /imutavel/)
    const snapshot = (await database.query(`select * from ${table}`)).rows
    const audit = (await database.query(`select * from ${history} order by changed_at`)).rows
    await database.exec(migration)
    assert.deepEqual((await database.query(`select * from ${table}`)).rows, snapshot)
    assert.deepEqual((await database.query(`select * from ${history} order by changed_at`)).rows, audit)
    assert.deepEqual((await database.query('select * from drops')).rows, before)
    assert.deepEqual((await database.query('select * from financial_periods')).rows, finance)
    assert.equal((await database.query("select count(*) from pg_policies where tablename='drops' and policyname='preserved'")).rows[0].count, 1)
  } finally { await database.close() }
})

function createMaisEnviosMock() {
  const fields = ['cnpj', 'smart', 'responsavel', 'telefone', 'email', 'endereco', 'numero', 'complemento', 'bairro', 'cidade', 'uf', 'cep', 'tamanho_camiseta']
  const state = { rows: Array.from({ length: 56 }, (_, index) => ({ ...Object.fromEntries(fields.map(field => [field, ''])),
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, smart: `Smart ${String(index + 1).padStart(2, '0')}`,
    etapa: index % 6 + 1, created_by: '11111111-1111-4111-8111-111111111111',
    created_at: '2026-10-23T12:00:00.000Z', updated_at: '2026-10-23T12:00:00.000Z' })), calls: [], history: [], tick: 0, fail: '', hold: false, release: null }
  return { state, from(table) {
    if (!['mais_envios_registrations', 'mais_envios_stage_history'].includes(table)) throw new Error(`Unexpected table ${table}`)
    let operation = 'select', payload, single = false, expression = '', start = 0, end = 999, ascending = true
    const filters = []
    const query = {
      select() { return query },
      insert(value) { operation = 'insert'; payload = value; return query },
      update(value) { operation = 'update'; payload = value; return query },
      eq(field, value) { filters.push([field, value]); return query },
      order(field, options) { if (field === 'created_at') ascending = options?.ascending !== false; return query },
      range(from, to) { start = from; end = to; return query },
      limit(count) { end = count - 1; return query },
      or(value) { expression = value; return query },
      maybeSingle() { single = true; return query },
      then(resolve, reject) { return Promise.resolve().then(async () => {
        state.calls.push({ table, operation, payload, filters, expression, start, end })
        if (state.hold) await new Promise(done => { state.release = done })
        if (state.fail === operation) { state.fail = ''; return { data: null, error: { message: 'Falha simulada' } } }
        const source = table === 'mais_envios_registrations' ? state.rows : state.history
        let rows = source.filter(row => filters.every(([field, value]) => row[field] === value))
        if (expression) {
          const search = expression.match(/ilike\."%((?:\\.|[^"\\])*)%"/)?.[1]?.replace(/\\(.)/g, '$1').toLowerCase() ?? ''
          rows = rows.filter(row => fields.some(field => row[field]?.toLowerCase().includes(search)))
        }
        if (operation === 'insert') {
          if (state.rows.some(row => row.id === payload.id)) return { data: null, error: { message: 'Chave duplicada', code: '23505' } }
          const timestamp = new Date(Date.UTC(2026, 9, 23, 13, 0, ++state.tick)).toISOString()
          const row = { ...payload, created_by: '11111111-1111-4111-8111-111111111111', created_at: timestamp, updated_at: timestamp }
          source.push(row); rows = [row]
          state.history.push({ id: `history-${state.tick}`, registration_id: row.id, previous_stage: null, etapa: row.etapa, changed_by: row.created_by, changed_at: timestamp })
        }
        if (operation === 'update') rows.forEach(row => {
          const previous = row.etapa
          Object.assign(row, payload, { updated_at: new Date(Date.UTC(2026, 9, 23, 13, 0, ++state.tick)).toISOString() })
          if (previous !== row.etapa) state.history.push({ id: `history-${state.tick}`, registration_id: row.id, previous_stage: previous, etapa: row.etapa,
            changed_by: '22222222-2222-4222-8222-222222222222', changed_at: row.updated_at })
        })
        if (state.fail === `${operation}After`) { state.fail = ''; return { data: null, error: { message: 'Resposta perdida' } } }
        const count = rows.length
        rows = [...rows].sort((first, second) => ((ascending ? 1 : -1) * String(first.created_at).localeCompare(String(second.created_at))) || first.id.localeCompare(second.id))
        const selected = rows.slice(start, end + 1).map(row => ({ ...row }))
        return { data: single ? selected[0] ?? null : selected, count, error: null }
      }).then(resolve, reject) },
    }
    return query
  } }
}

test('Mais Envios navegador: lista, filtros, CRUD sem DELETE, CEP, concorrencia, permissoes e mobile', async () => {
  const plugins = [{ name: 'mais-envios-offline', setup(builder) {
    builder.onResolve({ filter: /^\.\/(access|lib\/supabase)$/ }, args => ({ path: args.path, namespace: 'mais-envios-mock' }))
    builder.onLoad({ filter: /.*/, namespace: 'mais-envios-mock' }, args => ({ loader: 'tsx', resolveDir: process.cwd(), contents:
      args.path === './access' ? 'export const useAccess = () => globalThis.__maisTest.access'
        : 'export const supabase = globalThis.__maisTest.client' }))
  } }]
  const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {BrowserRouter, Routes, Route} from 'react-router-dom';
    import './src/styles.css'; import './src/navigation.css'; import './src/formatting.css'; import './src/clean-ui.css';
    import './src/brand.css'; import './src/operations.css'; import './src/financial.css'; import './src/legacy-features.css';
    import MaisEnvios from './src/MaisEnvios';
    const root=createRoot(document.getElementById('root'));
    globalThis.__maisTest.render=()=>root.render(<BrowserRouter><div className="app"><aside>Movidos</aside><main className="content">
      <Routes><Route path="/cadastros/mais-envios" element={<MaisEnvios/>}/>
      <Route path="/cadastros/mais-envios/novo" element={<MaisEnvios view="form"/>}/></Routes>
    </main></div></BrowserRouter>); globalThis.__maisTest.render();`, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, outdir: 'tmp/mais-envios', entryNames: 'bundle', jsx: 'automatic', format: 'esm', plugins, external: ['/brand/*'],
    define: { 'process.env.NODE_ENV': '"production"' } })
  const javascript = bundle.outputFiles.find(file => file.path.endsWith('.js')).text
  const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/bundle.js' ? 'text/javascript' : request.url === '/bundle.css' ? 'text/css' : 'text/html; charset=utf-8')
    response.end(request.url === '/bundle.js' ? javascript : request.url === '/bundle.css' ? css
      : '<!doctype html><meta name="viewport" content="width=980"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script type="module" src="/bundle.js"></script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  let browser
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const externalRequests = [], errors = []
    await context.route('**/*', route => {
      if (route.request().url().startsWith(`${origin}/`)) return route.continue()
      if (route.request().url() === 'https://viacep.com.br/ws/01001000/json/') return route.fulfill({ contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ cep: '01001-000', logradouro: 'Rua do teste', bairro: 'Centro', localidade: 'Sao Paulo', uf: 'SP' }) })
      externalRequests.push(route.request().url()); return route.abort()
    })
    await context.addInitScript(`globalThis.__maisTest={client:(${createMaisEnviosMock.toString()})(),
      access:{loading:false,profile:{is_active:true},can:name=>['cadastros_view','cadastros_create','cadastros_edit'].includes(name)}}`)
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/cadastros/mais-envios`)
    await page.getByText('56 cadastros | Pagina 1 de 3', { exact: true }).waitFor()
    assert.equal(await page.locator('tbody tr').count(), 25)
    await page.getByRole('button', { name: 'Proxima', exact: true }).click()
    await page.getByText('56 cadastros | Pagina 2 de 3', { exact: true }).waitFor()
    await page.getByLabel('Busca', { exact: true }).fill('Smart 29')
    await page.getByText('1 cadastro | Pagina 1 de 1', { exact: true }).waitFor()
    await page.getByLabel('Etapa', { exact: true }).selectOption('6')
    await page.getByText('Nenhum cadastro encontrado.', { exact: true }).waitFor()
    await page.getByLabel('Etapa', { exact: true }).selectOption('5')
    await page.getByRole('button', { name: 'Editar Smart 29', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Limpar filtros', exact: true }).click()
    await page.getByText('56 cadastros | Pagina 1 de 3', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Novo cadastro', exact: true }).click()
    await page.locator('.me-stages li').first().waitFor()
    assert.equal(await page.locator('.me-stages li').count(), 6)
    await page.getByLabel('Smart (nome)', { exact: true }).fill('Nova smart teste')
    await page.getByLabel('CNPJ', { exact: true }).fill('12.345.678/0001-99')
    await page.getByLabel('Responsavel', { exact: true }).fill('Responsavel ficticio')
    await page.getByLabel('Telefone', { exact: true }).fill('(11) 99999-0000')
    await page.getByLabel('Email', { exact: true }).fill('ficticio@example.test')
    await page.getByLabel('Tamanho camiseta', { exact: true }).fill('GG')
    await page.getByLabel('CEP', { exact: true }).fill('01001-000')
    await page.waitForFunction(() => document.querySelector('[name=endereco]')?.value === 'Rua do teste')
    assert.equal(await page.getByLabel('Endereco', { exact: true }).inputValue(), 'Rua do teste')
    assert.equal(await page.getByLabel('Bairro', { exact: true }).inputValue(), 'Centro')
    assert.equal(await page.getByLabel('Cidade', { exact: true }).inputValue(), 'Sao Paulo')
    assert.equal(await page.getByLabel('UF', { exact: true }).inputValue(), 'SP')
    await page.getByLabel('Numero', { exact: true }).fill('0010')
    await page.getByLabel('Complemento', { exact: true }).fill('Sala 2')
    await page.getByLabel('Status / etapa', { exact: true }).selectOption('3')
    assert.equal(await page.locator('.me-stage-concluida').count(), 2)
    assert.equal(await page.locator('.me-stage-atual').count(), 1)
    assert.equal(await page.locator('.me-stage-pendente').count(), 3)
    await page.evaluate(() => { const form = document.querySelector('.me-form'); form.requestSubmit(); form.requestSubmit() })
    await page.waitForURL(/edit=/)
    await page.getByRole('region', { name: 'Historico de etapas', exact: true }).getByText('Cadastro criado', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('Smart (nome)', { exact: true }).inputValue(), 'Nova smart teste')
    const inserted = await page.evaluate(() => __maisTest.client.state.rows.find(row => row.smart === 'Nova smart teste'))
    assert.equal(inserted.cnpj, '12345678000199'); assert.equal(inserted.cep, '01001000'); assert.equal(inserted.numero, '0010')
    assert.equal(await page.evaluate(() => __maisTest.client.state.calls.filter(call => call.operation === 'insert').length), 1)
    await page.getByLabel('Status / etapa', { exact: true }).selectOption('6')
    await page.getByRole('button', { name: 'Salvar cadastro', exact: true }).click()
    await page.getByText('Cadastro salvo.', { exact: true }).waitFor()
    await page.getByText('Etapa 3 para 6', { exact: true }).waitFor()
    assert.equal(await page.locator('.me-stage-concluida').count(), 5)
    await page.evaluate(id => { const row = __maisTest.client.state.rows.find(row => row.id === id); row.smart = 'Alterado por outra sessao'; row.updated_at = '2026-10-23T20:00:00.000Z' }, inserted.id)
    await page.getByLabel('Smart (nome)', { exact: true }).fill('Edicao obsoleta')
    await page.getByRole('button', { name: 'Salvar cadastro', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'O cadastro mudou' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Salvar cadastro', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: 'Verificar cadastro', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[name=smart]')?.value === 'Alterado por outra sessao')
    await page.evaluate(() => { __maisTest.client.state.fail = 'updateAfter' })
    await page.getByLabel('Smart (nome)', { exact: true }).fill('Salvo com resposta perdida')
    await page.getByRole('button', { name: 'Salvar cadastro', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Resposta perdida' }).waitFor()
    await page.getByRole('button', { name: 'Verificar cadastro', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[name=smart]')?.value === 'Salvo com resposta perdida' && !document.querySelector('[name=smart]').disabled)
    const updateCall = await page.evaluate(() => __maisTest.client.state.calls.find(call => call.operation === 'update'))
    assert.ok(updateCall.filters.some(([field]) => field === 'updated_at'))
    await mkdir('tmp/mais-envios', { recursive: true })
    await page.screenshot({ path: 'tmp/mais-envios/form-desktop.png', fullPage: true })
    for (const width of [390, 844]) {
      await page.setViewportSize({ width, height: 900 })
      assert.equal(await page.locator('.mais-envios').evaluate(element => element.getBoundingClientRect().right <= innerWidth + 1), true)
      assert.equal(await page.locator('.me-stages').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true)
      for (const control of await page.locator('.mais-envios input, .mais-envios select, .mais-envios button').all()) {
        assert.equal(await control.evaluate(element => element.getBoundingClientRect().right <= innerWidth + 1), true)
      }
      await page.screenshot({ path: `tmp/mais-envios/form-${width}.png`, fullPage: true })
    }
    await page.evaluate(() => { __maisTest.access.can = name => name === 'cadastros_view'; __maisTest.render() })
    await page.getByRole('button', { name: 'Salvar cadastro', exact: true }).waitFor({ state: 'detached' })
    assert.equal(await page.getByLabel('Smart (nome)', { exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: 'Voltar para lista', exact: true }).click()
    await page.getByText('57 cadastros | Pagina 1 de 3', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Novo cadastro', exact: true }).count(), 0)
    assert.equal(await page.getByRole('button', { name: /^Editar / }).count(), 0)
    await page.screenshot({ path: 'tmp/mais-envios/list-mobile.png', fullPage: true })
    await page.evaluate(() => { __maisTest.access.profile.is_active = false; __maisTest.access.can = () => true; __maisTest.render() })
    await page.getByRole('alert').filter({ hasText: 'Sem permissao' }).waitFor()
    const afterDenied = await page.evaluate(() => __maisTest.client.state.calls.length)
    await page.evaluate(() => __maisTest.render())
    assert.equal(await page.evaluate(() => __maisTest.client.state.calls.length), afterDenied)
    assert.deepEqual(errors, [])
    assert.deepEqual(externalRequests, [])
    await context.close()
  } finally {
    if (browser) await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
})