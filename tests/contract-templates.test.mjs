import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

await build({ entryPoints: ['api/contract-templates.ts'], outfile: 'tmp/contract-tests/api.cjs', bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const module = await import(pathToFileURL(`${process.cwd()}/tmp/contract-tests/api.cjs`).href)
const handler = module.default.default ?? module.default

test('contract template changes require an active administrator even on direct API requests', async () => {
  const originalEnv = { ...process.env }
  const originalFetch = globalThis.fetch
  let profile = { role: 'admin', is_active: true }, invalidToken = false, writes = 0
  const invoke = async (body = { serviceTemplatePath: 'contract-templates/service/modelo.docx' }, authorization = 'Bearer test-only', method = 'POST') => {
    let result
    const response = { status(status) { this.statusCode = status; return this }, json(value) { result = { status: this.statusCode, body: value }; return this } }
    await handler({ method, headers: { authorization }, body }, response)
    return result
  }
  try {
    Object.assign(process.env, { SUPABASE_URL: 'https://template-test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-only' })
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url ?? String(input))
      assert.equal(url.origin, 'https://template-test.supabase.co')
      if (url.pathname === '/auth/v1/user') return Response.json(invalidToken ? { message: 'Invalid' } : { id: '11111111-1111-4111-8111-111111111111' }, { status: invalidToken ? 401 : 200 })
      if (url.pathname === '/rest/v1/user_profiles') return Response.json(profile ? [profile] : [])
      assert.ok(url.pathname.endsWith('/movidos-documents/contract-templates/config.json'))
      if (init?.method === 'POST') { writes++; return Response.json({ Key: 'contract-templates/config.json' }) }
      return Response.json({ serviceTemplatePath: '' })
    }
    assert.equal((await invoke(undefined, '')).status, 401)
    invalidToken = true; assert.equal((await invoke()).status, 401); invalidToken = false
    for (const candidate of [null, { role: 'admin', is_active: false }, { role: 'operador', is_active: true }, { role: 'financeiro', is_active: true }]) {
      profile = candidate
      assert.ok([401, 403].includes((await invoke({ serviceTemplatePath: 'contract-templates/service/forged.docx', role: 'admin' })).status))
    }
    assert.equal(writes, 0)
    profile = { role: 'admin', is_active: true }
    assert.equal((await invoke({ serviceTemplatePath: 'drops/not-a-template.pdf' })).status, 400)
    assert.equal(writes, 0)
    assert.equal((await invoke()).status, 200)
    assert.equal((await invoke({ serviceTemplatePath: '' })).status, 200)
    assert.equal(writes, 2)
  } finally {
    globalThis.fetch = originalFetch
    for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name]
    Object.assign(process.env, originalEnv)
  }
})