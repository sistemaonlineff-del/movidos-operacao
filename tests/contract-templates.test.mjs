import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

await build({ entryPoints: ['api/contract-templates.ts'], outfile: 'tmp/contract-tests/api.cjs', bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const module = await import(pathToFileURL(`${process.cwd()}/tmp/contract-tests/api.cjs`).href)
const handler = module.default.default ?? module.default

test('contract PDF splits long paragraphs within A4 margins and numbers every page',async()=>{
  await build({entryPoints:['src/contractPdf.ts'],outfile:'tmp/contract-tests/pdf.cjs',bundle:true,platform:'node',format:'cjs',packages:'external'})
  const {renderContractPdf}=await import(pathToFileURL(`${process.cwd()}/tmp/contract-tests/pdf.cjs`).href)
  const document=renderContractPdf([{text:'CONTRATO DE SERVICOS'},{text:Array.from({length:1800},(_,index)=>`palavra${index}`).join(' ')},{text:'FINAL DO DOCUMENTO',pageBreak:true}])
  const loading=getDocument({data:new Uint8Array(document.output('arraybuffer')),useSystemFonts:true})
  try{
    const pdf=await loading.promise
    assert.ok(pdf.numPages>4)
    let fullText=''
    for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber++){
      const page=await pdf.getPage(pageNumber),content=await page.getTextContent(),height=page.getViewport({scale:1}).height
      assert.ok(content.items.some(item=>item.str===`MOVIDOS | ${pageNumber} / ${pdf.numPages}`))
      for(const item of content.items.filter(item=>item.str?.trim()&&!item.str.startsWith('MOVIDOS |'))){
        assert.ok(item.transform[4]>=61&&item.transform[4]+item.width<=535,`Horizontal overflow: ${item.str}`)
        assert.ok(height-item.transform[5]>=69&&height-item.transform[5]<=769,`Vertical overflow: ${item.str}`)
        fullText+=item.str+' '
      }
    }
    assert.ok(fullText.includes('palavra1799'));assert.ok(fullText.includes('FINAL DO DOCUMENTO'))
    const firstPage = await pdf.getPage(1), content = await firstPage.getTextContent()
    const body = content.items.filter(item => /palavra\d/.test(item.str))
    const baseline = body[0].transform[5]
    const firstLine = body.filter(item => Math.abs(item.transform[5] - baseline) < .1)
    assert.ok(Math.abs(Math.max(...firstLine.map(item => item.transform[4] + item.width)) - 184 * 72 / 25.4) < 2, 'Body lines must reach the justified right margin')
  }finally{await loading.destroy()}
})

test('contract template changes require an active administrator even on direct API requests', async () => {
  const originalEnv = { ...process.env }
  const originalFetch = globalThis.fetch
  let profile = { role: 'admin', is_active: true }, invalidToken = false, writes = 0
  const configs = new Map()
  const invoke = async (body = { serviceTemplatePath: 'contract-templates/service/modelo.docx' }, authorization = 'Bearer test-only', method = 'POST') => {
    let result
    const response = { setHeader() {}, status(status) { this.statusCode = status; return this }, json(value) { result = { status: this.statusCode, body: value }; return this } }
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
      assert.match(url.pathname,/\/movidos-documents\/contract-templates\/(config|termination-config)\.json$/)
      if (init?.method === 'POST') { writes++; const file=init.body instanceof FormData?[...init.body.values()].find(value=>value instanceof Blob):init.body;configs.set(url.pathname,JSON.parse(await file.text()));return Response.json({ Key: 'contract-templates/config.json' }) }
      return Response.json(configs.get(url.pathname)??{})
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
    assert.equal((await invoke({terminationTemplatePath:'contract-templates/termination/distrato.docx'})).status,200)
    assert.equal((await invoke(undefined,'Bearer test-only','GET')).body.serviceTemplatePath,'contract-templates/service/modelo.docx')
    assert.equal((await invoke({terminationTemplatePath:'contract-templates/service/modelo.docx'})).status,400)
    assert.equal((await invoke({ serviceTemplatePath: '' })).status, 200)
    assert.equal((await invoke(undefined,'Bearer test-only','GET')).body.terminationTemplatePath,'contract-templates/termination/distrato.docx')
    assert.equal(writes, 3)
  } finally {
    globalThis.fetch = originalFetch
    for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name]
    Object.assign(process.env, originalEnv)
  }
})