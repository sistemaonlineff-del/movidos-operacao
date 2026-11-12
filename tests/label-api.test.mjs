import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

await mkdir('tmp/label-api-tests', { recursive: true })
await build({ entryPoints: ['server/label-auth.ts', 'api/label-routes.ts', 'api/label-read.ts', 'api/label-volume.ts', 'src/labelMatching.ts', 'src/labelRequest.ts'], outdir: 'tmp/label-api-tests', outbase: '.', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const { authorizeLabelReader, LabelApiError } = await import(pathToFileURL(`${process.cwd()}/tmp/label-api-tests/server/label-auth.cjs`).href)
const { findLabelMatches } = await import(pathToFileURL(`${process.cwd()}/tmp/label-api-tests/src/labelMatching.cjs`).href)
const { labelRequest } = await import(pathToFileURL(`${process.cwd()}/tmp/label-api-tests/src/labelRequest.cjs`).href)

test('label requests recover temporary failures with bounded retries and stable capture identity', async () => {
  const originalFetch = globalThis.fetch, originalTimer = globalThis.setTimeout
  const delays = [], bodies = []
  globalThis.setTimeout = (callback, delay, ...args) => { if (delay === 38000) return originalTimer(callback, delay, ...args); delays.push(delay); return originalTimer(callback, 0, ...args) }
  try {
    const responses = [Response.json({ error: 'Limite' }, { status: 429, headers: { 'Retry-After': '2' } }), Response.json({ error: 'Temporario' }, { status: 502 }), Response.json({ saved: true })]
    globalThis.fetch = async (url, init) => { bodies.push(init.body); return responses.shift() }
    const body = JSON.stringify({ scanKey: 'same-capture-12345', driverId: 'original-driver', baseId: 'original-base' })
    assert.deepEqual(await labelRequest('/api/label-volume', { method: 'POST', body, retryNetwork: true }), { saved: true })
    assert.deepEqual(bodies, [body, body, body])
    assert.deepEqual(delays, [2000, 2000])
    for (const status of [400, 401, 403, 409, 422, 503]) {
      let calls = 0
      globalThis.fetch = async () => { calls++; return Response.json({ error: 'Permanente', retryable: false }, { status }) }
      await assert.rejects(labelRequest('/api/label-read', { method: 'POST' }), /Permanente/)
      assert.equal(calls, 1)
    }
    let calls = 0
    globalThis.fetch = async () => { calls++; return Response.json({ error: 'Ainda indisponivel', retryable: true }, { status: 503 }) }
    await assert.rejects(labelRequest('/api/label-volume', { method: 'POST', body }), /Ainda indisponivel/)
    assert.equal(calls, 3)
    calls = 0
    globalThis.fetch = async () => { if (++calls === 1) throw new TypeError('Network'); return Response.json({ saved: true }) }
    await labelRequest('/api/label-volume', { method: 'POST', body, retryNetwork: true })
    assert.equal(calls, 2)
    calls = 0
    globalThis.fetch = async () => { calls++; throw new TypeError('Network') }
    await assert.rejects(labelRequest('/api/label-read', { method: 'POST' }), /Network/)
    assert.equal(calls, 1)
    const controller = new AbortController()
    globalThis.fetch = async () => Response.json({ error: 'Temporario' }, { status: 502 })
    await assert.rejects(labelRequest('/api/label-read', { method: 'POST', signal: controller.signal, onRetry: () => controller.abort() }), error => error.name === 'AbortError')
  } finally { globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimer }
})

const matchingRecord = { id: 'one', street: 'Rua Sintetica', neighborhood: 'Centro', postalCode: '08600-000', city: 'Suzano', zone: 'Norte', region: 'Regiao 1', route: 'R1', deliverySequence: 10, mapsUrl: '', routeUrl: '', sourceSheet: 'Base', sourceRow: 1 }
const matchingQuery = 'Rua Sintetica, Centro, Suzano, 08600-000'

test('label matching does not interpret connecting words inside a longer street as letter streets', () => {
  for (const [street, shortName] of [['Rua Vinte e Dois de Abril', 'E'], ['Rua Caminho a Serra', 'A'], ['Rua Caminho do Lago', 'Do']]) {
    const correct = { ...matchingRecord, street, neighborhood: 'Jardim Sintetico' }
    const unrelated = { ...matchingRecord, id: 'two', street: `Rua ${shortName}`, neighborhood: 'Outro Bairro', postalCode: '08600-001', route: 'R2' }
    for (const postalCode of ['08600-001', '08600-000']) {
      assert.deepEqual(findLabelMatches(`${street}\nJardim Sintetico\nSuzano\n08600-000`, [correct, { ...unrelated, postalCode }]).map(match => match.record.id), ['one'])
    }
    for (const query of [`Rua ${shortName}, 15, Outro Bairro, Suzano, 08600-001`, `${shortName}\nOutro Bairro\nSuzano\n08600-001`]) {
      assert.deepEqual(findLabelMatches(query, [correct, unrelated]).map(match => match.record.id), ['two'])
    }
  }
})

test('label matching does not treat the neighborhood on the next line as another street', () => {
  const correct = { ...matchingRecord, street: 'Rua Aurora', neighborhood: 'Jardim Horizonte II' }
  const unrelated = { ...matchingRecord, id: 'two', street: 'Avenida Horizonte', neighborhood: 'Jardim Central', postalCode: '08600-001', route: 'R2' }
  for (const street of ['Rua Aurora', 'Aurora']) {
    const matches = findLabelMatches(`${street}\nJardim Horizonte II\nSuzano\n08600-000`, [correct, unrelated])
    assert.deepEqual(matches.map(match => match.record.id), ['one'])
    assert.equal(matches[0].streetMatch, true)
    assert.equal(matches[0].warnings.some(warning => /aproximado|divergente|diferente|não confirmada/i.test(warning)), false)
  }
})

test('label matching collapses identical route rows from repeated sources without altering the base', () => {
  const original = { ...matchingRecord }, repeated = { ...matchingRecord, id: 'two', sourceFile: 'outra-importacao.xlsx', sourceRow: 99 }
  const records = [original, repeated], before = structuredClone(records), matches = findLabelMatches(matchingQuery, records)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].record.id, 'one')
  assert.equal(matches[0].warnings.some(warning => warning.includes('CEP compartilhado')), false)
  assert.deepEqual(records, before)
  assert.equal(records.length, 2)
})

test('label matching preserves conflicting route details as separate possibilities', () => {
  for (const change of [{ zone: 'Sul' }, { region: 'Regiao 2' }, { route: 'R2' }, { deliverySequence: 11 }, { postalCode: '08600-001' }, { mapsUrl: 'https://maps.example.invalid/another-point' }, { routeUrl: 'https://maps.example.invalid/another-route' }]) {
    assert.equal(findLabelMatches(matchingQuery, [matchingRecord, { ...matchingRecord, ...change, id: 'two' }]).length, 2, JSON.stringify(change))
  }
  assert.equal(findLabelMatches('Rua Sintetica, Centro, 08600-000', [matchingRecord, { ...matchingRecord, id: 'two', city: 'Outra cidade' }]).length, 2)
})

test('label APIs distinguish provider configuration, rate limits and missing database migrations without leaking raw errors', async () => {
  const originalFetch = globalThis.fetch, originalLog = console.error
  const environment = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GEMINI_API_KEY'].map(name => [name, process.env[name]]))
  const logs = [], userId = '11111111-1111-4111-8111-111111111111'
  let providerStatus = 503, storageCode = '42703', writes = 0
  process.env.SUPABASE_URL = 'https://local-test.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-test-key'
  process.env.GEMINI_API_KEY = 'local-provider-key'
  console.error = (...args) => logs.push(args)
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input))
    if (url.hostname === 'generativelanguage.googleapis.com') return Response.json({ error: { message: 'raw-private-provider-message' } }, { status: providerStatus })
    assert.equal(url.origin, 'https://local-test.supabase.co')
    if (url.pathname === '/auth/v1/user') return Response.json({ id: userId, email: 'synthetic@example.invalid' })
    if (url.pathname.endsWith('user_profiles')) return Response.json([{ role: 'operador', is_active: true, full_name: 'Motorista' }])
    if (url.pathname.endsWith('user_module_permissions')) return Response.json([{ label_reader_access: true }])
    if (url.pathname.endsWith('delivery_volumes')) {
      if (init?.method === 'POST' || input.method === 'POST') writes++
      return Response.json({ code: storageCode, message: 'raw-private-database-message' }, { status: 400 })
    }
    throw new Error('Unexpected mocked request')
  }
  const invoke = async (name, body) => {
    const { default: module } = await import(pathToFileURL(`${process.cwd()}/tmp/label-api-tests/api/${name}.cjs`).href)
    const handler = module.default ?? module
    const result = { headers: {}, statusCode: 0, body: null }
    const response = { setHeader(key, value) { result.headers[key] = value }, status(value) { result.statusCode = value; return this }, json(value) { result.body = value; return this } }
    await handler({ method: 'POST', headers: { authorization: 'Bearer local-test-token' }, body }, response)
    assert.equal(JSON.stringify(result).includes('raw-private'), false)
    return result
  }
  try {
    for (const [status, expected, retryable] of [[429, 429, true], [503, 502, true], [403, 503, false], [404, 503, false], [400, 503, false]]) {
      providerStatus = status
      const result = await invoke('label-read', { image: 'data:image/jpeg;base64,/9j/AA==' })
      assert.equal(result.statusCode, expected)
      assert.equal(result.body.retryable, retryable)
      if (status === 429) assert.equal(result.headers['Retry-After'], '60')
      if (status === 403 || status === 404 || status === 400) assert.match(result.body.error, /administrador/)
    }
    for (const code of ['42P01', '42703', 'PGRST204', 'PGRST205']) {
      storageCode = code
      const result = await invoke('label-volume', { baseId: 'base-1', scanKey: 'same-local-capture-12345' })
      assert.equal(result.statusCode, 503)
      assert.equal(result.body.retryable, false)
      assert.match(result.body.error, /atualizacao no banco/)
    }
    storageCode = 'PGRST002'
    assert.equal((await invoke('label-volume', { baseId: 'base-1', scanKey: 'same-local-capture-12345' })).body.retryable, true)
    storageCode = '42501'
    assert.equal((await invoke('label-volume', { baseId: 'base-1', scanKey: 'same-local-capture-12345' })).body.retryable, false)
    assert.equal(writes, 0, 'No insert when the idempotency lookup failed')
    assert.equal(JSON.stringify(logs).includes('raw-private'), false)
    assert.equal(JSON.stringify(logs).includes('local-provider-key'), false)
  } finally {
    globalThis.fetch = originalFetch; console.error = originalLog
    for (const [name, value] of Object.entries(environment)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  }
})

test('label authorization validates identity, active profile and reader permission without external requests', async () => {
  const originalFetch = globalThis.fetch
  const originalUrl = process.env.SUPABASE_URL
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  let profile = { role: 'operador', is_active: true }
  let permissions = { label_reader_access: true }
  let invalidSession = false
  let permissionFailure = false
  let calls = []
  const request = { headers: { authorization: 'Bearer local-test-token' } }
  const denied = status => error => error instanceof LabelApiError && error.status === status
  process.env.SUPABASE_URL = 'https://local-test.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-test-key'
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input))
    assert.equal(url.origin, 'https://local-test.supabase.co')
    calls.push(url.pathname)
    if (url.pathname === '/auth/v1/user') {
      assert.equal(new Headers(init?.headers ?? input.headers).get('authorization'), 'Bearer local-test-token')
      return Response.json(invalidSession ? { message: 'Invalid token' } : { id: '11111111-1111-4111-8111-111111111111', email: 'test@example.com' }, { status: invalidSession ? 401 : 200 })
    }
    assert.equal(url.searchParams.get(url.pathname.endsWith('user_profiles') ? 'id' : 'user_id'), 'eq.11111111-1111-4111-8111-111111111111')
    if (url.pathname === '/rest/v1/user_profiles') return Response.json(profile ? [profile] : [])
    if (url.pathname === '/rest/v1/user_module_permissions') return Response.json(permissionFailure ? { message: 'Database unavailable' } : permissions ? [permissions] : [], { status: permissionFailure ? 403 : 200 })
    throw new Error('Unexpected request')
  }
  try {
    await assert.rejects(authorizeLabelReader({ headers: {} }), denied(401))
    await assert.rejects(authorizeLabelReader({ headers: { authorization: 'Basic invalid' } }), denied(401))
    assert.equal(calls.length, 0)
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    await assert.rejects(authorizeLabelReader(request), denied(503))
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-test-key'
    invalidSession = true
    await assert.rejects(authorizeLabelReader(request), denied(401))
    invalidSession = false
    profile = { role: 'admin', is_active: false }
    await assert.rejects(authorizeLabelReader(request), denied(403))
    profile = null
    await assert.rejects(authorizeLabelReader(request), denied(403))
    profile = { role: 'operador', is_active: true }
    permissions = null
    await assert.rejects(authorizeLabelReader(request), denied(403))
    permissions = { label_reader_access: false }
    await assert.rejects(authorizeLabelReader(request), denied(403))
    permissions = { label_reader_access: true }
    assert.ok((await authorizeLabelReader(request)).from)
    permissionFailure = true
    await assert.rejects(authorizeLabelReader(request), denied(503))
    profile = { role: 'admin', is_active: true }
    calls = []
    assert.ok((await authorizeLabelReader(request)).from)
    assert.ok(!calls.includes('/rest/v1/user_module_permissions'))
    for (const name of ['label-routes', 'label-read', 'label-volume']) {
      const { default: module } = await import(pathToFileURL(`${process.cwd()}/tmp/label-api-tests/api/${name}.cjs`).href)
      const handler = module.default ?? module
      let status
      let body
      const response = { setHeader() {}, status(value) { status = value; return this }, json(value) { body = value; return this } }
      await handler({ method: name === 'label-volume' ? 'POST' : 'GET', headers: {}, body: { baseId: 'test', scanKey: 'local-test-scan-12345' } }, response)
      assert.equal(status, 401, name)
      assert.equal(typeof body.error, 'string')
      profile = { role: 'operador', is_active: true }
      permissions = { label_reader_access: false }
      permissionFailure = false
      await handler({ method: name === 'label-volume' ? 'POST' : 'GET', headers: request.headers, body: { baseId: 'test', scanKey: 'local-test-scan-12345' } }, response)
      assert.equal(status, 403, `${name}: revoked permission with an existing valid token`)
      assert.equal(typeof body.error, 'string')
    }
  } finally {
    globalThis.fetch = originalFetch
    if (originalUrl === undefined) delete process.env.SUPABASE_URL
    else process.env.SUPABASE_URL = originalUrl
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey
  }
})