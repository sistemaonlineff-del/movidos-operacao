import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSync } from 'esbuild'
import { createClient } from '@supabase/supabase-js'

const compiled = buildSync({ entryPoints: ['src/cadastrosFilters.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
const { CADASTRO_TEXT_FILTERS, createCadastroFilters, applyCadastroFilters, numericMaskPattern } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)

function recorder() {
  const calls = []
  const query = Object.fromEntries(['eq', 'ilike', 'filter', 'or'].map(method => [method, (...args) => { calls.push([method, ...args]); return query }]))
  return { query, calls }
}

test('initial status and combined fields preserve the registration kind', () => {
  const filters = createCadastroFilters()
  assert.equal(filters.status, 'ATIVO')
  Object.assign(filters, { legacy_id: '00123', partner: 'J&T EXPRESS LTDA', zone: 'LESTE', query: 'Loja' })
  for (const { field } of CADASTRO_TEXT_FILTERS) filters[field] = 'teste'
  const { query, calls } = recorder()
  assert.equal(applyCadastroFilters(query, filters, 'drop_off'), query)
  assert.deepEqual(calls.slice(0, 5), [['or', 'registration_type.is.null,registration_type.eq.drop_off'], ['eq', 'status', 'ATIVO'], ['eq', 'partner', filters.partner], ['eq', 'zone', 'LESTE'], ['eq', 'legacy_id', 123]])
  for (const { field } of CADASTRO_TEXT_FILTERS) assert.ok(calls.some(call => call[0] === 'ilike' && call[1] === field && call[2] === '%teste%'), field)
  assert.match(calls.at(-1)[1], /name\.ilike\."\*Loja\*"/)
})

test('all-status export removes only status, never kind or the other filters', () => {
  for (const kind of ['drop_off', 'last_mile']) {
    const filters = { ...createCadastroFilters(), name: 'Loja', municipality: 'Suzano', query: 'Centro', page: 4 }
    const normal = recorder(), exported = recorder()
    applyCadastroFilters(normal.query, filters, kind)
    applyCadastroFilters(exported.query, filters, kind, true)
    assert.deepEqual(exported.calls, normal.calls.filter(call => !(call[0] === 'eq' && call[1] === 'status')))
    assert.deepEqual(exported.calls[0], kind === 'last_mile' ? ['eq', 'registration_type', 'last_mile'] : ['or', 'registration_type.is.null,registration_type.eq.drop_off'])
  }
})

test('phone, CNPJ and CEP match masked and unmasked values without skipping digits', () => {
  for (const [field, digits, masked] of [['phone', '11987654321', '(11) 98765-4321'], ['cnpj', '12345678000190', '12.345.678/0001-90'], ['postal_code', '01234567', '01234-567']]) {
    for (const input of [digits, masked]) {
      const { query, calls } = recorder()
      applyCadastroFilters(query, { ...createCadastroFilters(), [field]: input }, 'drop_off')
      const [, , operator, pattern] = calls.find(call => call[0] === 'filter' && call[1] === field)
      assert.equal(operator, 'match')
      assert.equal(pattern, numericMaskPattern(digits))
      assert.ok(new RegExp(pattern).test(digits))
      assert.ok(new RegExp(pattern).test(masked))
      assert.ok(!new RegExp(pattern).test(`${digits.slice(0, 4)}9${digits.slice(4)}`))
    }
  }
})

test('PostgREST punctuation is quoted, wildcard-only input is inert and invalid IDs cannot broaden results', () => {
  const attack = 'x"),registration_type.eq.last_mile,name.ilike.*\\'
  const { query, calls } = recorder()
  applyCadastroFilters(query, { ...createCadastroFilters(), query: attack, name: attack, legacy_id: '1),status.neq.ATIVO' }, 'drop_off')
  const expression = calls.at(-1)[1]
  const values = [...expression.matchAll(/(?:^|,)(\w+)\.ilike\."((?:\\.|[^"\\])*)"(?=,|$)/g)]
  assert.equal(values.length, 6)
  assert.equal(values.map(match => match[0]).join('').length, expression.length)
  assert.deepEqual(calls.filter(call => call[1] === 'legacy_id'), [['eq', 'legacy_id', -1], ['eq', 'legacy_id', -2]])
  const empty = recorder()
  applyCadastroFilters(empty.query, { ...createCadastroFilters(''), query: '*%', name: '%*' }, 'last_mile')
  assert.deepEqual(empty.calls, [['eq', 'registration_type', 'last_mile']])
})

test('numeric general search keeps ID search and adds normalized contact matches', () => {
  const { query, calls } = recorder()
  applyCadastroFilters(query, { ...createCadastroFilters(), query: '01234567' }, 'last_mile')
  assert.match(calls.at(-1)[1], /legacy_id\.eq\.1234567/)
  for (const field of ['phone', 'cnpj', 'postal_code']) assert.ok(calls.at(-1)[1].includes(`${field}.match."${numericMaskPattern('01234567')}"`))
})

test('real Supabase builder retains both OR groups and pagination without a network request', async () => {
  const captured = []
  const client = createClient('https://cadastros.example.test', 'local-test-only', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async input => {
      captured.push(new URL(String(input)))
      return new Response('[]', { headers: { 'content-type': 'application/json', 'content-range': '0-0/0' } })
    } },
  })
  const filters = { ...createCadastroFilters(), query: 'Loja', phone: '(11) 98765-4321', page: 2 }
  const query = client.from('drops').select('*', { count: 'exact' })
  applyCadastroFilters(query, filters, 'drop_off')
  const { error } = await query.order('legacy_id', { ascending: false }).range(100, 149)
  assert.equal(error, null)
  const params = captured[0].searchParams
  assert.equal(params.getAll('or').length, 2)
  assert.equal(params.getAll('or')[0], '(registration_type.is.null,registration_type.eq.drop_off)')
  assert.match(params.getAll('or')[1], /name\.ilike/)
  assert.equal(params.get('phone'), `match.${numericMaskPattern(filters.phone)}`)
  assert.equal(params.get('status'), 'eq.ATIVO')
  assert.equal(params.get('offset'), '100')
  assert.equal(params.get('limit'), '50')
})