import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

await build({entryPoints:['src/dropRegistrationShared.ts'],outfile:'tmp/drop-registration/shared.mjs',bundle:true,platform:'node',format:'esm'})
const shared = await import(pathToFileURL(`${process.cwd()}/tmp/drop-registration/shared.mjs`))
export const snapshot = {name:'Drop Sintetico',responsible:'Pessoa Teste',phone:'11999999999',address:'Rua Teste',address_number:'10',neighborhood:'Centro',municipality:'Suzano',state:'SP',postal_code:'08600000',pix_key:'teste@example.invalid',pix_holder_name:'Pessoa Teste',latitude:-23.5,longitude:-46.3}

test('public snapshot whitelist, explicit coordinates and actual delegated permissions', () => {
  for (const field of ['status','is_active','monthly_value','created_by','operation_started_at','visited']) assert.throws(()=>shared.validateRegistration({...snapshot,[field]:'forged'}),/Campo nao permitido/)
  assert.equal(shared.MAX_REQUEST_BYTES,4_500_000)
  assert.equal(shared.MIN_PHOTOS,3)
  assert.equal(shared.MAX_PHOTOS,5)
  assert.equal(shared.validateRegistration({...snapshot,pix_key:'',pix_holder_name:''}).pix_key,null)
  assert.equal(shared.validateRegistration({...snapshot,neighborhood:''}).neighborhood,null)
  assert.throws(()=>shared.validateRegistration({...snapshot,name:'Nome\ncom controle'}),/invalido/)
  for (const pix_key of ['invalid','123','not@valid','12345678901234']) assert.throws(()=>shared.validateRegistration({...snapshot,pix_key}),/PIX invalida/)
  for (const pix_key of ['52998224725','11222333000181','+55 (11) 99999-9999','12345678-1234-4234-8234-123456789012',snapshot.pix_key]) assert.equal(shared.validateRegistration({...snapshot,pix_key}).pix_key,pix_key)
  for (const latitude of ['',null,false,NaN,91,7]) assert.throws(()=>shared.validateRegistration({...snapshot,latitude}))
  assert.equal(shared.validateRegistration({...snapshot,latitude:0}).latitude,0)
  assert.throws(()=>shared.validateRegistration({...snapshot,longitude:0}))
  assert.throws(()=>shared.validateRegistration({...snapshot,cpf:'11111111111'}))
  assert.equal(shared.validateRegistration({...snapshot,cpf:'529.982.247-25'}).cpf,'52998224725')
  assert.equal(shared.canReviewDropRegistration({is_active:true,role:'admin'}),true)
  assert.equal(shared.canReviewDropRegistration({is_active:false,role:'admin'}),false)
  assert.equal(shared.canReviewDropRegistration({is_active:true,role:'operador'},{cadastros_manage:true,cadastros_edit:true}),false)
  assert.equal(shared.canReviewDropRegistration({is_active:true,role:'operador'},{cadastros_create:true,cadastros_edit:true}),true)
})