import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { chromium } from 'playwright'
import PizZip from 'pizzip'
import Docxtemplater from 'docxtemplater'
import { XMLParser } from 'fast-xml-parser'

const offlineSupabase = contents => ({ name: 'offline-supabase', setup(builder) { builder.onResolve({ filter: /^\.\/lib\/supabase$/ }, () => ({ path: 'supabase', namespace: 'offline' })); builder.onLoad({ filter: /.*/, namespace: 'offline' }, () => ({ contents })) } })
await build({ entryPoints: ['src/contractPdf.ts'], outfile: 'tmp/contract-pdf-tests/pdf.cjs', bundle: true, platform: 'node', format: 'cjs', packages: 'external', plugins: [offlineSupabase('export const supabase = null')] })
const { renderContractPdf } = await import(pathToFileURL(`${process.cwd()}/tmp/contract-pdf-tests/pdf.cjs`).href)
const browserBundle = await build({ entryPoints: ['src/contractPdf.ts'], bundle: true, format: 'iife', globalName: 'ContractPdf', write: false, plugins: [offlineSupabase('export const supabase = globalThis.contractTestSupabase')] })
let browser
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }) })
after(async () => { await browser?.close() })

const fixture = {
  nomeEmpresarial: 'EMPRESA DE TESTE', cnpj: '00.000.000/0000-00', logradouro: 'Rua Teste', numero: '1', bairro: 'Centro', municipio: 'Suzano', uf: 'SP', cep: '00000-000',
  logradouroCNPJ: 'Rua Teste', numeroCNPJ: '1', bairroCNPJ: 'Centro', municipioCNPJ: 'Suzano', ufCNPJ: 'SP', cepCNPJ: '00000-000', parceiro: 'PARCEIRO DE TESTE', valorPacote: '0,50',
  dataContrato: '02/09/2026', dataHoje: '23 de outubro de 2026', dataDistrato: '15/09/2026', motivoDistrato: 'Encerramento de teste',
}
const compact = text => text.replace(/\s+/g, '')

function modelParagraphs(bytes) {
  const document = new Docxtemplater(new PizZip(bytes), { paragraphLoop: true, linebreaks: true })
  document.render(fixture)
  const parsed = new XMLParser({ preserveOrder: true, trimValues: false, parseTagValue: false }).parse(document.getZip().file('word/document.xml').asText())
  const paragraphs = []
  const textOf = nodes => nodes.map(node => Object.entries(node).map(([key, value]) => key === '#text' ? value : Array.isArray(value) ? textOf(value) : '').join('')).join('')
  const visit = nodes => nodes.forEach(node => Object.entries(node).forEach(([key, value]) => {
    if (key === 'w:p') paragraphs.push(textOf(value).trim())
    else if (Array.isArray(value)) visit(value)
  }))
  visit(parsed)
  return paragraphs.filter(Boolean)
}

async function downloadedPdf(bytes, kind, { custom = false, unavailable = false } = {}) {
  const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' })
  const requests = [], calls = []
  try {
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url())
      requests.push({ path: url.pathname, method: request.method(), authorization: request.headers().authorization })
      assert.equal(url.origin, 'https://contract-pdf.test')
      assert.equal(request.method(), 'GET')
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>Contract test</title></head><body></body></html>' })
      if (url.pathname === '/api/contract-templates') return route.fulfill({ json: { serviceTemplatePath: 'contract-templates/service/custom.docx', terminationTemplatePath: 'contract-templates/termination/custom.docx' } })
      assert.equal(url.pathname, custom ? '/signed/modelo.docx' : `/templates/modelo-${kind}.docx`)
      return route.fulfill({ contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body: bytes })
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    await page.goto('https://contract-pdf.test/')
    await page.exposeFunction('recordContractCall', value => calls.push(value))
    await page.evaluate(({ custom, unavailable }) => {
      globalThis.contractTestSupabase = custom ? {
        auth: { getSession: async () => ({ data: { session: { access_token: 'offline-test-only' } } }) },
        storage: { from: bucket => ({ createSignedUrl: async (path, expires) => {
          await globalThis.recordContractCall({ bucket, path, expires })
          return unavailable ? { error: { message: 'Unavailable' } } : { data: { signedUrl: 'https://contract-pdf.test/signed/modelo.docx' } }
        } }) },
      } : null
    }, { custom, unavailable })
    await page.addScriptTag({ content: browserBundle.outputFiles[0].text })
    const downloads = []
    page.on('download', download => downloads.push(download))
    const result = await page.evaluate(async ({ fixture, kind }) => {
      try {
        await globalThis.ContractPdf.downloadContractPdf(`/templates/modelo-${kind}.docx`, fixture, `${kind}.pdf`)
        return null
      } catch (error) { return error.message }
    }, { fixture, kind })
    if (unavailable) {
      assert.match(result, /Nenhum documento foi gerado/)
      assert.equal(downloads.length, 0)
      return { requests, calls }
    }
    assert.equal(result, null)
    const download = downloads[0] ?? await page.waitForEvent('download')
    assert.equal(download.suggestedFilename(), `${kind}.pdf`)
    return { bytes: await readFile(await download.path()), requests, calls }
  } finally { await context.close() }
}

async function pdfItems(bytes) {
  const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true })
  try {
    const pdf = await loading.promise, items = []
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber), content = await page.getTextContent()
      items.push(...content.items.filter(item => item.str?.trim() && !item.str.startsWith('MOVIDOS |')).map(item => ({ ...item, pageNumber, pageWidth: page.getViewport({ scale: 1 }).width })))
    }
    return items
  } finally { await loading.destroy() }
}

test('contract PDF respects centered signature lines without bold or concatenation', async () => {
  const document = renderContractPdf([
    { text: 'CONTRATO DE TESTE' },
    { text: 'Texto juridico preservado.' },
    { text: '______________________________\nEMPRESA DE TESTE\nCNPJ: 00.000.000/0000-00\nCONTRATADA', align: 'center' },
    { text: 'Testemunhas:' },
  ])
  const loading = getDocument({ data: new Uint8Array(document.output('arraybuffer')), useSystemFonts: true })
  try {
    const pdf = await loading.promise
    const page = await pdf.getPage(1)
    const content = await page.getTextContent()
    let previousBaseline = Infinity
    for (const text of ['______________________________', 'EMPRESA DE TESTE', 'CNPJ: 00.000.000/0000-00', 'CONTRATADA']) {
      const line = content.items.find(item => item.str === text)
      assert.ok(line, `Missing separate signature line: ${text}`)
      assert.ok(Math.abs(line.transform[4] + line.width / 2 - page.getViewport({ scale: 1 }).width / 2) < 1, `Not centered: ${text}`)
      assert.ok(line.transform[5] < previousBaseline, `Overlapping signature line: ${text}`)
      previousBaseline = line.transform[5]
    }
    assert.ok(content.items.some(item => item.str === 'Texto juridico preservado.'))
    assert.ok(content.items.some(item => item.str === 'Testemunhas:'))
  } finally {
    await loading.destroy()
  }
})

test('bundled contract and termination keep legal text, final date and existing witnesses', async () => {
  for (const [kind, filename] of [['contrato', 'modelo-contrato-prestacao-servico.docx'], ['distrato', 'modelo-distrato-sociedade.docx']]) {
    const source = await readFile(`public/templates/${filename}`)
    const expected = modelParagraphs(source)
    const generated = await downloadedPdf(source, kind)
    const items = await pdfItems(generated.bytes), text = items.map(item => item.str).join(' ')
    assert.doesNotMatch(text, /Data do contrato:/)
    for (const paragraph of expected) {
      const fullText = compact(text), modelText = compact(paragraph)
      if (!fullText.includes(modelText)) {
        const position = fullText.indexOf(modelText.slice(0, 50))
        assert.equal(fullText.slice(Math.max(0, position), Math.max(0, position) + modelText.length), modelText, `Missing model text in ${kind}`)
      }
    }
    if (kind === 'distrato') {
      assert.ok(text.includes(`Data do distrato: ${fixture.dataDistrato}`))
      assert.ok(text.includes(`Motivo do distrato: ${fixture.motivoDistrato}`))
    }
    const closingDate = `Suzano, ${fixture.dataHoje}.`
    const signatureStart = items.findLastIndex(item => item.str === closingDate)
    assert.ok(signatureStart >= 0, `Missing legal closing date in ${kind}`)
    const modelDate = expected.lastIndexOf(closingDate), witnesses = expected.indexOf('Testemunhas:', modelDate)
    assert.ok(modelDate >= 0 && witnesses > modelDate)
    let previousIndex = signatureStart
    for (const signature of expected.slice(modelDate + 1, witnesses)) {
      const index = items.findIndex((item, itemIndex) => itemIndex > previousIndex && item.str === signature)
      assert.ok(index > previousIndex, `Missing separate signature line in ${kind}: ${signature}`)
      const line = items[index]
      assert.ok(Math.abs(line.transform[4] + line.width / 2 - line.pageWidth / 2) < 1, `Not centered in ${kind}: ${signature}`)
      previousIndex = index
    }
    assert.equal(generated.calls.length, 0)
  }
})

test('active custom models preserve their text, explicit signature breaks and witness choices', async () => {
  const zip = new PizZip(await readFile('public/templates/modelo-contrato-prestacao-servico.docx'))
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:r><w:t>MODELO PERSONALIZADO</w:t></w:r></w:p>
    <w:p><w:r><w:t>Texto juridico proprio: CONTRATADA e CONTRATANTE preservam o acordo.</w:t></w:r></w:p>
    <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>Suzano, {dataHoje}.</w:t></w:r></w:p>
    <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>______________________________</w:t><w:br/><w:t>{nomeEmpresarial}</w:t><w:br/><w:t>CNPJ: {cnpj}</w:t></w:r><w:r><w:br/><w:t>CONTRATADA</w:t></w:r></w:p>
    <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>______________________________</w:t><w:cr/><w:t>EMPRESA CONTRATANTE DE TESTE</w:t><w:cr/><w:t>CNPJ: {cnpj}</w:t><w:cr/><w:t>CONTRATANTE</w:t></w:r></w:p>
    <w:p><w:r><w:t>Testemunhas:</w:t></w:r></w:p>
    <w:p><w:r><w:t>______________________________</w:t><w:tab/><w:t>Nome:</w:t><w:br/><w:t>Documento:</w:t></w:r></w:p>
    </w:body></w:document>`)
  for (const kind of ['contrato', 'distrato']) {
    const generated = await downloadedPdf(zip.generate({ type: 'nodebuffer' }), kind, { custom: true })
    const items = await pdfItems(generated.bytes), text = items.map(item => item.str).join(' ')
    assert.ok(text.includes('MODELO PERSONALIZADO'))
    assert.ok(text.includes('Texto juridico proprio: CONTRATADA e CONTRATANTE preservam o acordo.'))
    assert.ok(text.includes(`Suzano, ${fixture.dataHoje}.`))
    assert.doesNotMatch(text, /Data do contrato:|Rogerio|Isabel|RG:/)
    const signatures = [fixture.nomeEmpresarial, 'EMPRESA CONTRATANTE DE TESTE', `CNPJ: ${fixture.cnpj}`, 'CONTRATADA', 'CONTRATANTE']
    for (const signature of signatures) {
      const lines = items.filter(item => item.str === signature)
      assert.equal(lines.length, signature.startsWith('CNPJ:') ? 2 : 1, `Missing separate custom line: ${signature}`)
      for (const line of lines) assert.ok(Math.abs(line.transform[4] + line.width / 2 - line.pageWidth / 2) < 1, `Not centered in custom model: ${signature}`)
    }
    for (const label of ['Testemunhas:', 'Nome:', 'Documento:']) assert.ok(text.includes(label))
    assert.deepEqual(generated.calls, [{ bucket: 'movidos-documents', path: `contract-templates/${kind === 'distrato' ? 'termination' : 'service'}/custom.docx`, expires: 120 }])
    assert.equal(generated.requests.find(request => request.path === '/api/contract-templates').authorization, 'Bearer offline-test-only')
  }
})

test('unavailable custom models still block downloads instead of falling back to bundled models', async () => {
  const generated = await downloadedPdf(Buffer.alloc(0), 'contrato', { custom: true, unavailable: true })
  assert.deepEqual(generated.requests.map(request => request.path), ['/', '/api/contract-templates'])
  assert.equal(generated.calls.length, 1)
})