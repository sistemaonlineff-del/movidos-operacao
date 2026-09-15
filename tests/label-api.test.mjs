import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

await mkdir('tmp/label-api-tests', { recursive: true })
await build({ entryPoints: ['server/label-auth.ts', 'api/label-routes.ts', 'api/label-read.ts', 'api/label-volume.ts'], outdir: 'tmp/label-api-tests', outbase: '.', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const { authorizeLabelReader, LabelApiError } = await import(pathToFileURL(`${process.cwd()}/tmp/label-api-tests/server/label-auth.cjs`).href)

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
    }
  } finally {
    globalThis.fetch = originalFetch
    if (originalUrl === undefined) delete process.env.SUPABASE_URL
    else process.env.SUPABASE_URL = originalUrl
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey
  }
})