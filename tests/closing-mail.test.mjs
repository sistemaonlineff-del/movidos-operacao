import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

await mkdir('tmp/mail-tests', { recursive: true })
await build({ entryPoints: ['server/closing-mail.ts'], outfile: 'tmp/mail-tests/mail.cjs', bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
await build({ entryPoints: ['api/financial/send-closing.ts'], outfile: 'tmp/mail-tests/handler.cjs', bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
await build({ entryPoints: ['api/financial/send-closing.ts', 'server/closing-mail.ts', 'src/financialData.ts', 'src/dropOptions.ts'], outdir: 'tmp/mail-tests/native', outbase: '.', bundle: false, platform: 'node', format: 'esm' })
const { configuredMailer } = await import(pathToFileURL(`${process.cwd()}/tmp/mail-tests/mail.cjs`).href)

test('mail connector blocks missing configuration and submits PDF to Microsoft only after authorization', async () => {
  const originalEnv = { ...process.env }
  const originalFetch = globalThis.fetch
  try {
    for (const name of Object.keys(process.env).filter(name => name.startsWith('MAIL_'))) delete process.env[name]
    assert.throws(configuredMailer, /remetente/)
    Object.assign(process.env, { MAIL_FROM: 'sender@example.com', MAIL_PROVIDER: 'microsoft365', MAIL_MS_TENANT_ID: 'test-tenant', MAIL_MS_CLIENT_ID: 'client', MAIL_MS_CLIENT_SECRET: 'test-secret' })
    let calls = 0
    let reject = false
    globalThis.fetch = async (url, init) => {
      calls++
      if (url.startsWith('https://login.microsoftonline.com/')) return Response.json({ access_token: 'test-only' })
      assert.equal(url, 'https://graph.microsoft.com/v1.0/users/sender%40example.com/sendMail')
      const payload = JSON.parse(init.body)
      assert.equal(payload.saveToSentItems, true)
      assert.equal(payload.message.toRecipients[0].emailAddress.address, 'drop@example.com')
      assert.equal(Buffer.from(payload.message.attachments[0].contentBytes, 'base64').toString(), '%PDF-test')
      assert.equal(payload.message.body.contentType, 'Text')
      return new Response(null, { status: reject ? 403 : 202 })
    }
    const mail = { to: 'drop@example.com', subject: 'Closing', body: 'Message', attachmentName: 'closing.pdf', pdf: Buffer.from('%PDF-test') }
    assert.equal(await configuredMailer()(mail), 'microsoft365')
    assert.equal(calls, 2)
    reject = true
    await assert.rejects(configuredMailer()(mail), /não confirmou/)
    globalThis.fetch = async () => new Response(null, { status: 401 })
    await assert.rejects(configuredMailer()(mail), /autorizar/)
  } finally {
    globalThis.fetch = originalFetch
    for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name]
    Object.assign(process.env, originalEnv)
  }
})

test('direct mail endpoint requires a bearer session before touching a provider', async () => {
  const module = await import(pathToFileURL(`${process.cwd()}/tmp/mail-tests/handler.cjs`).href)
  const handler = module.default.default ?? module.default
  let status
  const response = { setHeader() {}, status(value) { status = value; return this }, json() { return this } }
  await handler({ method: 'POST', headers: {}, body: {} }, response)
  assert.equal(status, 401)
  await handler({ method: 'DELETE', headers: {} }, response)
  assert.equal(status, 405)
})

test('SMTP requires verified TLS and sends only the supplied PDF attachment', async () => {
  const originalEnv = { ...process.env }
  let closed = false
  try {
    Object.assign(process.env, { MAIL_PROVIDER: 'smtp', MAIL_FROM: 'sender@example.com', MAIL_SMTP_HOST: 'smtp.example.com', MAIL_SMTP_PORT: '587', MAIL_SMTP_USER: 'sender@example.com', MAIL_SMTP_PASSWORD: 'test-only' })
    const createTransport = options => {
      assert.equal(options.requireTLS, true)
      assert.equal(options.tls.rejectUnauthorized, true)
      assert.equal(options.secure, false)
      return { close() { closed = true }, async sendMail(mail) {
        assert.equal(mail.to, 'drop@example.com')
        assert.equal(mail.disableFileAccess, true)
        assert.equal(mail.disableUrlAccess, true)
        assert.equal(mail.attachments[0].content.toString(), '%PDF-test')
        return { accepted: ['drop@example.com'], rejected: [] }
      } }
    }
    assert.equal(await configuredMailer(createTransport)({ to: 'drop@example.com', subject: 'Closing', body: 'Test', attachmentName: 'test.pdf', pdf: Buffer.from('%PDF-test') }), 'smtp')
    assert.equal(closed, true)
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name]
    Object.assign(process.env, originalEnv)
  }
})

test('API checks permissions, uses registered recipient, reserves once and never retries uncertain sends', async () => {
  const originalEnv = { ...process.env }
  const originalFetch = globalThis.fetch
  const module = await import(pathToFileURL(`${process.cwd()}/tmp/mail-tests/handler.cjs`).href)
  const handler = module.default.default ?? module.default
  const userId = '11111111-1111-4111-8111-111111111111'
  const dropId = '22222222-2222-4222-8222-222222222222'
  const periodId = '33333333-3333-4333-8333-333333333333'
  const partner = 'IMILE DELIVERY BRAZIL LTDA'
  let active = true, manage = false, providerFails = false, finishFails = false, testMode = false
  let role = 'operador'
  let sends = 0, reservations = 0, log = null
  const payload = { dropId, periodId, period: 'SETEMBRO', partner, subject: 'Test', body: 'Message', to: 'untrusted@example.com', pdf: Buffer.from('%PDF-1.7\n%%EOF').toString('base64') }
  const invoke = async (body = payload) => {
    let result
    const response = { setHeader() {}, status(status) { this.statusCode = status; return this }, json(value) { result = { status: this.statusCode, body: value }; return this } }
    await handler({ method: 'POST', headers: { authorization: 'Bearer test-token' }, body }, response)
    return result
  }
  try {
    Object.assign(process.env, { SUPABASE_URL: 'https://mail-test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-key', MAIL_PROVIDER: 'microsoft365', MAIL_FROM: 'sender@example.com', MAIL_MS_TENANT_ID: 'test-tenant', MAIL_MS_CLIENT_ID: 'test-client', MAIL_MS_CLIENT_SECRET: 'test-secret' })
    delete process.env.MAIL_TEST_RECIPIENT
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url ?? String(input))
      if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test-only' })
      if (url.hostname === 'graph.microsoft.com') {
        sends++
        const message = JSON.parse(init.body).message
        assert.equal(message.toRecipients[0].emailAddress.address, testMode ? 'fabioaf9@gmail.com' : 'registered@example.com')
        if (testMode) {
          assert.match(message.subject, /Teste/)
          assert.equal(message.attachments[0].name, 'movidos-teste-email.pdf')
          assert.match(Buffer.from(message.attachments[0].contentBytes, 'base64').toString('latin1'), /Documento ficticio/)
        }
        if (providerFails) throw new Error('Simulated lost response')
        return new Response(null, { status: 202 })
      }
      assert.equal(url.origin, 'https://mail-test.supabase.co')
      if (url.pathname === '/auth/v1/user') return Response.json({ id: userId })
      if (url.pathname.endsWith('/user_profiles')) return Response.json([{ role, is_active: active }])
      if (testMode) assert.ok(!['/drops', '/financial_periods', '/financial_drop_items', '/financial_payment_history'].some(path => url.pathname.endsWith(path)))
      if (url.pathname.endsWith('/user_module_permissions')) return Response.json([{ financeiro_manage: manage }])
      if (url.pathname.endsWith('/drops')) return Response.json([{ id: dropId, name: 'DROP', email: 'registered@example.com', responsible: 'Test' }])
      if (url.pathname.endsWith('/financial_periods')) return Response.json([{ id: periodId, label: 'SETEMBRO', partner, financial_view_id: 'view' }])
      if (url.pathname.endsWith('/financial_drop_items')) return Response.json([{ id: 'item' }])
      if (url.pathname.endsWith('/financial_payment_history')) return Response.json([])
      assert.ok(url.pathname.endsWith('/email_logs'))
      if (init?.method === 'POST') {
        if (log) return Response.json({ code: '23505', message: 'Duplicate' }, { status: 409 })
        reservations++
        log = { id: 'log-id', ...JSON.parse(init.body) }
        assert.equal(log.status, 'enviando')
        return Response.json({ id: log.id })
      }
      if (init?.method === 'PATCH') {
        if (finishFails) return Response.json({ message: 'Write failed' }, { status: 503 })
        Object.assign(log, JSON.parse(init.body))
        return new Response(null, { status: 204 })
      }
      return Response.json(log ? [log] : [])
    }
    assert.equal((await invoke()).status, 403)
    manage = true; active = false
    assert.equal((await invoke()).status, 403)
    active = true
    assert.equal((await invoke({ ...payload, pdf: 'invalid' })).status, 400)
    process.env.MAIL_TEST_RECIPIENT = 'another@example.com'
    assert.equal((await invoke()).status, 403)
    assert.equal(reservations, 0)
    delete process.env.MAIL_TEST_RECIPIENT
    const concurrent = await Promise.all([invoke(), invoke()])
    assert.ok(concurrent.some(result => result.body.status === 'aceito'))
    assert.equal(sends, 1)
    assert.equal(reservations, 1)
    assert.equal((await invoke()).body.duplicate, true)
    assert.equal(sends, 1)
    log = null; providerFails = true
    assert.equal((await invoke()).body.status, 'incerto')
    assert.equal((await invoke()).status, 409)
    assert.equal(sends, 2)
    log = null; providerFails = false; finishFails = true
    assert.equal((await invoke()).body.status, 'incerto')
    assert.equal((await invoke()).status, 409)
    assert.equal(sends, 3)
    testMode = true; log = null; finishFails = false
    const testPayload = { mode: 'test', to: 'forged@example.com', pdf: 'ignored', subject: 'ignored' }
    assert.equal((await invoke(testPayload)).status, 403)
    role = 'admin'
    process.env.MAIL_TEST_RECIPIENT = 'another@example.com'
    assert.equal((await invoke(testPayload)).status, 403)
    delete process.env.MAIL_TEST_RECIPIENT
    assert.equal((await invoke(testPayload)).body.status, 'aceito')
    assert.equal(log.financial_period_id, undefined)
    assert.equal(log.drop_id, undefined)
    assert.equal(log.recipient_email, 'fabioaf9@gmail.com')
    assert.equal((await invoke(testPayload)).body.duplicate, true)
    assert.equal(sends, 4)
  } finally {
    globalThis.fetch = originalFetch
    for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name]
    Object.assign(process.env, originalEnv)
  }
})

test('mail API loads in native Node ESM without bundler extension resolution', async () => {
  const { default: handler } = await import(pathToFileURL(`${process.cwd()}/tmp/mail-tests/native/api/financial/send-closing.js`).href)
  let status
  const response = { setHeader() {}, status(value) { status = value; return this }, json() { return this } }
  await handler({ method: 'GET', headers: {} }, response)
  assert.equal(status, 401)
})