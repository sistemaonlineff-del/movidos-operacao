import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const employeeId = '11111111-1111-4111-8111-111111111111'
const documentId = '22222222-2222-4222-8222-222222222222'
const userId = '33333333-3333-4333-8333-333333333333'
const path = `employees/${employeeId}/${documentId}/file.pdf`
const migrationPath = 'supabase/migrations/20261023120000_employee_documents.sql'

function createMockEmployeeClient() {
  const firstEmployee = '11111111-1111-4111-8111-111111111111'
  const secondEmployee = '44444444-4444-4444-8444-444444444444'
  const state = { documents: [], files: new Map(), calls: [], fail: '', releaseUpload: null, holdUpload: false }
  const error = message => ({ data: null, error: { message } })
  const client = {
    state,
    auth: {
      getSession: async () => ({ data: { session: { user: { id: '33333333-3333-4333-8333-333333333333' } } } }),
      getUser: async () => ({ data: { user: { id: '33333333-3333-4333-8333-333333333333' } } }),
    },
    from(table) {
      let operation = 'select', payload, single = false
      const filters = []
      const query = {
        select() { return query },
        insert(next) { operation = 'insert'; payload = next; return query },
        update(next) { operation = 'update'; payload = next; return query },
        eq(column, value) { filters.push(row => row[column] === value); return query },
        in(column, values) { filters.push(row => values.includes(row[column])); return query },
        order() { return query },
        single() { single = true; return query },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            state.calls.push({ table, operation, payload })
            if (table === 'employees') return { data: [
              { id: firstEmployee, full_name: 'Funcionario Um', personal_email: 'one@example.test', cpf: '12345678901' },
              { id: secondEmployee, full_name: 'Funcionario Dois', personal_email: 'two@example.test', cpf: '98765432100' },
            ], error: null }
            if (table === 'user_profiles') return { data: { role: 'admin', full_name: 'Teste local' }, error: null }
            if (table !== 'employee_documents') throw new Error(`Unexpected table ${table}`)
            const action = operation === 'insert' ? 'reserve' : operation === 'select' ? 'load' : payload.status === 'ready' ? 'confirm' : 'deleteMetadata'
            if (state.fail === action) { state.fail = ''; return error(`${action} failed`) }
            if (operation === 'insert') {
              state.documents.push({ ...payload, status: 'pending', created_at: '2026-10-23T12:00:00Z' })
            }
            const rows = state.documents.filter(row => filters.every(filter => filter(row)))
            if (operation === 'update') {
              if (payload.status === 'ready' && rows.some(row => !state.files.has(row.storage_path))) return error('Arquivo ainda nao confirmado no storage.')
              if (payload.status === 'deleted' && rows.some(row => state.files.has(row.storage_path))) return error('Remova o arquivo primeiro.')
              rows.forEach(row => Object.assign(row, payload))
            }
            if (state.fail === `${action}After`) { state.fail = ''; return error(`${action} response lost`) }
            return { data: single ? rows[0] ?? null : rows.map(row => ({ ...row })), error: null }
          }).then(resolve, reject)
        },
      }
      return query
    },
    storage: { from(bucket) {
      if (bucket !== 'employee-documents') throw new Error(`Unexpected bucket ${bucket}`)
      return {
        async upload(storagePath, file, options) {
          state.calls.push({ operation: 'upload', storagePath, options })
          if (state.holdUpload) await new Promise(resolve => { state.releaseUpload = resolve })
          if (state.fail === 'upload') { state.fail = ''; return error('upload failed') }
          if (state.files.has(storagePath) || options.upsert) return error('Overwrite forbidden')
          state.files.set(storagePath, file)
          if (state.fail === 'uploadAfter') { state.fail = ''; return error('upload response lost') }
          return { data: { path: storagePath }, error: null }
        },
        async download(storagePath) {
          state.calls.push({ operation: 'download', storagePath })
          if (state.fail === 'download') { state.fail = ''; return error('download failed') }
          return state.files.has(storagePath) ? { data: state.files.get(storagePath), error: null } : error('Not found')
        },
        async remove(paths) {
          state.calls.push({ operation: 'remove', paths })
          if (state.fail === 'remove') { state.fail = ''; return error('remove failed') }
          paths.forEach(storagePath => state.files.delete(storagePath))
          return { data: paths, error: null }
        },
      }
    } },
  }
  return client
}

const mockPlugin = {
  name: 'employee-documents-local-only',
  setup(builder) {
    builder.onResolve({ filter: /^\.\/(access|lib\/supabase)$/ }, args => ({ path: args.path, namespace: 'employee-test' }))
    builder.onLoad({ filter: /.*/, namespace: 'employee-test' }, args => ({ contents: args.path === './access'
      ? 'export const useAccess = () => globalThis.__employeeTest.access'
      : 'export const supabase = globalThis.__employeeTest.client' }))
  },
}
const serviceBundle = await build({ entryPoints: ['src/employeeDocuments.tsx'], bundle: true, write: false,
  jsx: 'automatic', format: 'esm', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [mockPlugin] })
globalThis.__employeeTest = { client: null }
const documents = await import(`data:text/javascript;base64,${Buffer.from(serviceBundle.outputFiles[0].text).toString('base64')}`)
const pdf = () => new File(['%PDF-1.7\nlocal test\n%%EOF'], 'comprovante.pdf', { type: 'application/pdf' })

test('employee document upload validates before writes and confirms only after private upload', async () => {
  for (const file of [new File(['%PDF-x'], 'script.html'), new File([], 'empty.pdf'),
    new File(['invalid'], 'fake.pdf', { type: 'application/pdf' }),
    new File(['%PDF-x'], 'wrong.pdf', { type: 'image/png' }),
    new File(['%PDF-x'], '../file.pdf'), new File([new Uint8Array(15728641)], 'large.pdf')]) {
    const client = createMockEmployeeClient()
    await assert.rejects(documents.uploadEmployeeDocument(client, employeeId, file))
    assert.equal(client.state.calls.length, 0)
  }
  const client = createMockEmployeeClient()
  await documents.uploadEmployeeDocument(client, employeeId, pdf())
  assert.deepEqual(client.state.calls.map(call => call.operation), ['insert', 'upload', 'update'])
  assert.equal(client.state.documents[0].status, 'ready')
  assert.match(client.state.documents[0].storage_path, new RegExp(`^employees/${employeeId}/[\\da-f-]+/file\\.pdf$`))
  assert.equal(client.state.calls[1].options.upsert, false)
  await documents.uploadEmployeeDocument(client, employeeId, pdf())
  assert.notEqual(client.state.documents[0].storage_path, client.state.documents[1].storage_path)
  assert.equal((await documents.listEmployeeDocuments(client, employeeId)).length, 2)
  assert.equal((await documents.listEmployeeDocuments(client, 'other-employee')).length, 0)
})

test('employee document partial uploads remain recoverable without deleting uncertain committed objects', async () => {
  for (const failure of ['reserve', 'reserveAfter', 'upload', 'uploadAfter', 'confirm', 'confirmAfter']) {
    const client = createMockEmployeeClient()
    client.state.fail = failure
    await assert.rejects(documents.uploadEmployeeDocument(client, employeeId, pdf()))
    assert.equal(client.state.calls.some(call => call.operation === 'remove'), false)
    if (failure === 'reserve') { assert.equal(client.state.documents.length, 0); continue }
    const item = client.state.documents[0]
    if (['reserveAfter', 'upload'].includes(failure)) {
      assert.equal(item.status, 'pending')
      await assert.rejects(documents.confirmEmployeeDocument(client, item), { message: /nao confirmado/ })
    } else if (failure !== 'confirmAfter') {
      await documents.confirmEmployeeDocument(client, item)
      assert.equal(item.status, 'ready')
    } else assert.equal(item.status, 'ready')
    await documents.deleteEmployeeDocument(client, item)
    assert.equal(item.status, 'deleted')
    assert.equal(client.state.files.size, 0)
  }
})

test('employee document deletion preserves metadata on failure and supports retry after file removal', async () => {
  const client = createMockEmployeeClient()
  await documents.uploadEmployeeDocument(client, employeeId, pdf())
  const item = client.state.documents[0]
  client.state.fail = 'remove'
  await assert.rejects(documents.deleteEmployeeDocument(client, item), { message: /remove failed/ })
  assert.equal(item.status, 'ready')
  assert.equal(client.state.files.size, 1)
  client.state.fail = 'deleteMetadata'
  await assert.rejects(documents.deleteEmployeeDocument(client, item), { message: /deleteMetadata failed/ })
  assert.equal(item.status, 'ready')
  assert.equal(client.state.files.size, 0)
  await documents.deleteEmployeeDocument(client, item)
  assert.equal(item.status, 'deleted')
  assert.equal((await documents.listEmployeeDocuments(client, employeeId)).length, 0)
})

test('employee documents: private storage, permissions, immutable scope, recoverable deletion and repeatable migration', async () => {
  const database = new PGlite()
  try {
    await database.exec(`create role anon; create role authenticated; create schema auth; create schema storage;
      create table auth.users(id uuid primary key); insert into auth.users values('${userId}');
      create function auth.uid() returns uuid language sql as $$select '${userId}'::uuid$$;
      create function is_active_user() returns boolean language sql as $$select coalesce(current_setting('test.active',true),'yes') = 'yes'$$;
      create function has_module_permission(permission text) returns boolean language sql as $$select current_setting('test.access',true) = 'admin' or current_setting('test.access',true) = permission$$;
      create table employees(id uuid primary key, full_name text, auth_user_id uuid);
      insert into employees values('${employeeId}','Preservado','${userId}');
      alter table employees enable row level security;
      create policy employee_existing on employees for select to authenticated using(is_active_user() and (has_module_permission('funcionarios_view') or has_module_permission('funcionarios_manage')));
      grant select on employees to authenticated;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb);
      alter table storage.objects enable row level security;
      create policy legacy_wide on storage.objects for all to public using(true) with check(true);
      grant usage on schema storage,auth to authenticated,anon;
      grant all on storage.objects to authenticated,anon;
      insert into storage.objects(bucket_id,name) values('other-bucket','preserved');`)
    const original = (await database.query('select * from employees')).rows
    const policies = (await database.query("select * from pg_policies where tablename = 'employees'")).rows
    const migration = await readFile(migrationPath, 'utf8')
    await database.exec(migration)
    await database.exec(migration)
    assert.equal((await database.query("select public from storage.buckets where id='employee-documents'")).rows[0].public, false)
    const reserve = `insert into employee_documents(id,employee_id,file_name,mime_type,size_bytes,storage_path) values('${documentId}','${employeeId}','arquivo.pdf','application/pdf',12,'${path}')`
    await database.exec("set role authenticated; select set_config('test.access','funcionarios_manage',false)")
    await database.exec(reserve)
    await assert.rejects(database.exec(`update employee_documents set status='ready' where id='${documentId}'`), /nao confirmado/)
    await assert.rejects(database.exec(`insert into storage.objects(bucket_id,name) values('employee-documents','employees/forged')`), /row-level security/)
    await database.exec(`insert into storage.objects(bucket_id,name,metadata) values('employee-documents','${path}','{"size":12,"mimetype":"application/pdf"}')`)
    await database.exec(`update employee_documents set status='ready' where id='${documentId}'`)
    await database.exec("select set_config('test.access','funcionarios_view',false)")
    assert.equal((await database.query('select * from employee_documents')).rows.length, 1)
    assert.equal((await database.query("select * from storage.objects where bucket_id='employee-documents'")).rows.length, 1)
    assert.equal((await database.query("delete from storage.objects where bucket_id='employee-documents' returning *")).rows.length, 0)
    assert.equal((await database.query(`update employee_documents set status='deleted' returning *`)).rows.length, 0)
    await assert.rejects(database.exec(reserve), /permissao|row-level security/)
    for (const access of ['none','cadastros_edit','financeiro_manage']) {
      await database.query("select set_config('test.access',$1,false)", [access])
      assert.equal((await database.query('select * from employee_documents')).rows.length, 0)
      assert.equal((await database.query("select * from storage.objects where bucket_id='employee-documents'")).rows.length, 0)
      await assert.rejects(database.exec(`insert into storage.objects(bucket_id,name) values('employee-documents','${path}')`), /row-level security/)
    }
    await database.exec("select set_config('test.access','admin',false); select set_config('test.active','no',false)")
    assert.equal((await database.query('select * from employee_documents')).rows.length, 0)
    assert.equal((await database.query("select * from storage.objects where bucket_id='employee-documents'")).rows.length, 0)
    await database.exec("select set_config('test.active','yes',false)")
    await assert.rejects(database.exec(`update employee_documents set storage_path='other'`), /permission denied/)
    await assert.rejects(database.exec('delete from employee_documents'), /permission denied/)
    assert.equal((await database.query("update storage.objects set name='overwrite' where bucket_id='employee-documents' returning *")).rows.length, 0)
    await assert.rejects(database.exec("update employee_documents set status='deleted'"), /antes de excluir/)
    await database.exec("delete from storage.objects where bucket_id='employee-documents'")
    await database.exec("update employee_documents set status='deleted'")
    assert.equal((await database.query('select deleted_by from employee_documents')).rows[0].deleted_by, userId)
    await assert.rejects(database.exec(`insert into storage.objects(bucket_id,name) values('employee-documents','${path}')`), /row-level security/)
    await database.exec('reset role; set role anon')
    await assert.rejects(database.exec('select * from employee_documents'), /permission denied/)
    assert.equal((await database.query("select * from storage.objects where bucket_id='employee-documents'")).rows.length, 0)
    assert.equal((await database.query("select * from storage.objects where bucket_id='other-bucket'")).rows.length, 1)
    await assert.rejects(database.exec(`insert into storage.objects(bucket_id,name) values('employee-documents','${path}')`), /permission denied|row-level security/)
    await database.exec('reset role')
    await database.exec(migration)
    assert.deepEqual((await database.query('select * from employees')).rows, original)
    assert.deepEqual((await database.query("select * from pg_policies where tablename = 'employees'")).rows, policies)
    assert.equal((await database.query("select count(*) from storage.objects where bucket_id='other-bucket'")).rows[0].count, 1)
    assert.equal((await database.query('select status from employee_documents')).rows[0].status, 'deleted')
  } finally {
    await database.close()
  }
})

test('employee documents browser: saved employee button, upload, reload, download, delete, read-only and mobile', async () => {
  const bundle = await build({ stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
    import Funcionarios from './src/Funcionarios';
    const root = createRoot(document.getElementById('root'));
    globalThis.__employeeTest.render = () => root.render(React.createElement(Funcionarios));
    globalThis.__employeeTest.render();`, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, jsx: 'automatic', outdir: 'tmp/employee-documents', entryNames: 'bundle', format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' }, plugins: [mockPlugin] })
  const javascript = bundle.outputFiles.find(file => file.path.endsWith('.js')).text
  const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/bundle.js' ? 'text/javascript' : request.url === '/bundle.css' ? 'text/css' : 'text/html; charset=utf-8')
    response.end(request.url === '/bundle.js' ? javascript : request.url === '/bundle.css' ? css
      : '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/bundle.css"><style>body{font-family:Verdana,sans-serif;margin:16px}button{cursor:pointer;padding:8px;border:1px solid #b9cdd2;border-radius:6px;background:white}.table-wrap{overflow:auto}td,th{padding:8px;text-align:left}#root{max-width:1200px;margin:auto}</style><div id="root"></div><script type="module" src="/bundle.js"></script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
    const externalRequests = [], browserErrors = []
    await context.route('**/*', route => {
      if (route.request().url().startsWith(`${origin}/`)) return route.continue()
      externalRequests.push(route.request().url()); return route.abort()
    })
    await context.addInitScript(`globalThis.__employeeTest = {client: (${createMockEmployeeClient.toString()})(),
      access: {profile: {is_active:true}, can: name => ['funcionarios_view','funcionarios_manage'].includes(name)}};`)
    const page = await context.newPage()
    page.on('pageerror', error => browserErrors.push(error.message))
    await page.goto(origin)
    const employeeRow = page.getByRole('row').filter({ hasText: 'Funcionario Um' })
    await employeeRow.waitFor().catch(error => { throw new Error(`Employee list failed to render: ${browserErrors.join('; ')}`, { cause: error }) })
    assert.equal(await employeeRow.getByRole('button', { name: 'Convidar', exact: true }).count(), 1)
    await employeeRow.getByRole('button', { name: 'Documentos', exact: true }).click()
    const panel = page.getByRole('region', { name: 'Documentos de Funcionario Um', exact: true })
    await panel.getByText('Nenhum documento anexado.').waitFor()
    await page.evaluate(() => { __employeeTest.client.state.holdUpload = true })
    await panel.locator('input[type=file]').setInputFiles({ name: 'comprovante.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nlocal test\n%%EOF') })
    await panel.getByText('Processando documento...').waitFor()
    assert.equal(await panel.getByRole('button', { name: 'Anexar documento', exact: true }).isDisabled(), true)
    await page.waitForFunction(() => typeof __employeeTest.client.state.releaseUpload === 'function')
    await page.evaluate(() => { __employeeTest.client.state.releaseUpload(); __employeeTest.client.state.holdUpload = false })
    await panel.getByText('Documento salvo.', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => __employeeTest.client.state.documents.length), 1)
    await panel.getByRole('button', { name: 'Fechar', exact: true }).click()
    await employeeRow.getByRole('button', { name: 'Documentos', exact: true }).click()
    await panel.getByText('comprovante.pdf', { exact: true }).waitFor()
    const downloadEvent = page.waitForEvent('download')
    await panel.getByRole('button', { name: 'Baixar comprovante.pdf', exact: true }).click()
    const download = await downloadEvent
    assert.equal(download.suggestedFilename(), 'comprovante.pdf')
    const stream = await download.createReadStream(), chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    assert.equal(Buffer.concat(chunks).toString(), '%PDF-1.7\nlocal test\n%%EOF')
    await panel.getByRole('button', { name: 'Atualizar', exact: true }).waitFor({ state: 'visible' })
    await page.evaluate(() => { __employeeTest.client.state.fail = 'download' })
    await panel.getByRole('button', { name: 'Baixar comprovante.pdf', exact: true }).click()
    await panel.getByRole('alert').filter({ hasText: 'download failed' }).waitFor()
    await page.evaluate(() => { __employeeTest.access.can = name => name === 'funcionarios_view'; __employeeTest.render() })
    await panel.getByRole('button', { name: 'Anexar documento', exact: true }).waitFor({ state: 'detached' })
    assert.equal(await panel.getByRole('button', { name: 'Excluir comprovante.pdf', exact: true }).count(), 0)
    await panel.getByRole('button', { name: 'Baixar comprovante.pdf', exact: true }).waitFor()
    await page.evaluate(() => { __employeeTest.access.can = () => true; __employeeTest.render() })
    await panel.getByRole('button', { name: 'Anexar documento', exact: true }).waitFor()
    await mkdir('tmp/employee-documents', { recursive: true })
    await panel.screenshot({ path: 'tmp/employee-documents/desktop.png' })
    await page.setViewportSize({ width: 390, height: 844 })
    await panel.scrollIntoViewIfNeeded()
    await panel.screenshot({ path: 'tmp/employee-documents/mobile.png' })
    assert.equal(await panel.evaluate(element => element.getBoundingClientRect().right <= innerWidth + 1), true)
    assert.equal(await panel.evaluate(element => element.getBoundingClientRect().width <= innerWidth), true)
    assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true)
    for (const button of await panel.getByRole('button').all()) {
      assert.equal(await button.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true)
    }
    page.once('dialog', dialog => dialog.dismiss())
    await panel.getByRole('button', { name: 'Excluir comprovante.pdf', exact: true }).click()
    assert.equal(await page.evaluate(() => __employeeTest.client.state.files.size), 1)
    await page.evaluate(() => { __employeeTest.client.state.fail = 'deleteMetadata' })
    page.once('dialog', dialog => dialog.accept())
    await panel.getByRole('button', { name: 'Excluir comprovante.pdf', exact: true }).click()
    await panel.getByRole('alert').filter({ hasText: 'deleteMetadata failed' }).waitFor()
    page.once('dialog', dialog => dialog.accept())
    await panel.getByRole('button', { name: 'Excluir comprovante.pdf', exact: true }).click()
    await panel.getByText('Documento excluido.', { exact: true }).waitFor()
    await panel.getByText('Nenhum documento anexado.').waitFor()
    await panel.getByRole('button', { name: 'Fechar', exact: true }).click()
    await page.getByRole('row').filter({ hasText: 'Funcionario Dois' }).getByRole('button', { name: 'Documentos', exact: true }).click()
    await page.getByRole('region', { name: 'Documentos de Funcionario Dois', exact: true }).getByText('Nenhum documento anexado.').waitFor()
    assert.equal(await page.evaluate(() => __employeeTest.client.state.calls.filter(call => ['employees','user_profiles'].includes(call.table) && call.operation !== 'select').length), 0)
    assert.deepEqual(externalRequests, [])
    assert.deepEqual(browserErrors, [])
    await context.close()
  } finally {
    await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
})