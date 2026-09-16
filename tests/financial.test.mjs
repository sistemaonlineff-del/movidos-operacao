import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

await mkdir('tmp/financial-tests', { recursive: true })
await build({ entryPoints: ['src/financialData.ts'], outfile: 'tmp/financial-tests/data.mjs', bundle: true, platform: 'node', format: 'esm' })
await build({ entryPoints: ['src/cnabInter.ts'], outfile: 'tmp/financial-tests/cnab.mjs', bundle: true, platform: 'node', format: 'esm' })
await build({ entryPoints: ['src/cnabSpreadsheet.ts'], outfile: 'tmp/financial-tests/spreadsheet.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external' })
await build({ entryPoints: ['src/closingSpreadsheet.ts'], outfile: 'tmp/financial-tests/closing.cjs', bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const { createClosingTemplate, readClosingSummary, readHistoricalPayments } = await import(pathToFileURL(`${process.cwd()}/tmp/financial-tests/closing.cjs`).href)
const { readCnabSpreadsheet } = await import(pathToFileURL(`${process.cwd()}/tmp/financial-tests/spreadsheet.mjs`).href)
const { buildDetails, buildTotals, lossClass, lossesFor, number, splitLosses } = await import(pathToFileURL(`${process.cwd()}/tmp/financial-tests/data.mjs`).href)
const { createCnabInter, pixKeyType, prepareCnabPayments } = await import(pathToFileURL(`${process.cwd()}/tmp/financial-tests/cnab.mjs`).href)
const periods = [{ id: 'p1', label: '33. 1Q DE AGOSTO', partner: 'IMILE DELIVERY BRAZIL LTDA', financial_view_id: 'v1', net_amount: null }, { id: 'p2', label: '33. 1Q DE AGOSTO', partner: 'J&T EXPRESS LTDA', financial_view_id: 'v1', net_amount: null }]
const item = { id: 'i1', financial_period_id: 'p1', drop_name_snapshot: 'VNM', quantity_packages: 2168, unit_value: .13, reimbursement: 0 }
const loss = (id, status, amount, period = 'p1') => ({ id, financial_period_id: period, period_label: periods[0].label, drop_name_snapshot: 'VNM', status, amount })

test('status rules distinguish deducted, assumed, waived and legacy losses', () => {
  const result = splitLosses([loss('1', 'PUDO Missing', 10.25), loss('2', ' d2d missing ', 20.15), loss('3', 'PUDO Missing - não cobrei', 5), loss('4', 'D2D Missing - não cobrei', 7), loss('5', 'PUDO Missing - não descontei 159,99', 159.99), loss('6', 'PUDO Extravio (Lost)', 8), loss('7', 'Outro', -2)])
  assert.equal(result.deducted, 30.4)
  assert.equal(result.assumed, 12)
  assert.equal(result.loss, 208.39)
  assert.equal(lossClass('PUDO Missing - não cobrei').chargeable, false)
  assert.equal(number('R$ 1.234,56'), 1234.56)
  assert.equal(number('281.84'), 281.84)
})
test('new closings stay visible alongside history and persisted source links prevent duplicates after renaming', () => {
  const history = [{ id: 'h1', financial_period_id: 'p1', period_label: periods[0].label, partner: 'Patrícia', drop_name_snapshot: 'Renomeado', package_quantity: 2168, amount: .13, subtotal: 281.84, total_receivable: 281.84, loss_amount: 0, observation: JSON.stringify({ movidosClosing: { sourceItemId: 'i1', packageType: 'W2D', w2d: 0, d2d: 0 } }) }]
  const details = buildDetails(history, [item, { ...item, id: 'i2', financial_period_id: 'p2', drop_name_snapshot: 'NOVO' }], [], periods)
  assert.equal(details.length, 2)
  assert.equal(details.find(row => row.id === 'h1').drop, 'Renomeado')
  assert.equal(details.find(row => row.id === 'i2').receivable, 281.84)
})
test('same DROP under different partners never shares losses', () => {
  const rows = [loss('1', 'PUDO Missing', 10), loss('2', 'D2D Missing', 100, 'p2'), loss('3', 'D2D Missing - não cobrei', 30)]
  const detail = buildDetails([], [item], rows, periods)[0]
  assert.equal(detail.loss, 10)
  assert.equal(detail.receivable, 271.84)
  assert.equal(lossesFor(detail, rows, periods).length, 2)
})
test('duplicate DROP rows share occurrences without duplicate deductions or lost cents', () => {
  const items = ['1', '2', '3'].map(id => ({ ...item, id, quantity_packages: 1 }))
  const details = buildDetails([], items, [loss('one-cent', 'PUDO Missing', .01)], periods)
  assert.equal(details.reduce((sum, row) => sum + row.loss, 0), .01)
  assert.equal(details.reduce((sum, row) => sum + row.w2d, 0), .01)
})
test('legacy people become responsible while the logistics partner and reference default correctly', () => {
  const legacyPeriods = [{ ...periods[0], partner: 'Eduardo' }, { ...periods[1], partner: 'Felipe' }]
  const details = buildDetails([], [item, { ...item, id: 'i2', financial_period_id: 'p2' }], [loss('first', 'PUDO Missing', 10), loss('second', 'PUDO Missing', 20, 'p2')], legacyPeriods)
  assert.deepEqual(details.map(row => row.responsible), ['Eduardo', 'Felipe'])
  assert.ok(details.every(row => row.partner === 'IMILE DELIVERY BRAZIL LTDA' && row.referenceCnpj === 'MOVIDOS'))
  assert.deepEqual(details.map(row => row.loss), [10, 20])
  const totals = buildTotals(details, [], legacyPeriods, [{ id: 'v1', notes: JSON.stringify({ summary: { invoice: 1000 } }) }], '', 'IMILE DELIVERY BRAZIL LTDA')
  assert.equal(totals[0].net, 1000)
})
test('invoice and gross follow the closing rule; reimbursement is only recorded', () => {
  const details = buildDetails([], [item, { ...item, id: 'i2', financial_period_id: 'p2' }], [], periods)
  const views = [{ id: 'v1', notes: JSON.stringify({ summary: { gross: 1100, invoice: 1000, reimbursement: 50, w2d: 25, d2d: 75, loss: 100 } }) }]
  const occurrences = [loss('w2d', 'PUDO Missing', 25), loss('d2d', 'D2D Missing - não cobrei', 75), loss('ignored', 'PUDO Extravio (Lost)', 999)]
  const total = buildTotals(details, occurrences, periods, views)[0]
  assert.equal(total.gross, 1100); assert.equal(total.net, 1000)
  assert.equal(total.payable, 563.68); assert.equal(total.companyPayment, 436.32)
  assert.equal(total.w2d, 25); assert.equal(total.d2d, 75); assert.equal(total.loss, 100)
  assert.equal(total.deducted, 25); assert.equal(total.assumed, 75)
  const filtered = buildTotals(details, [], periods, views, '', periods[0].partner)[0]
  assert.equal(filtered.gross, null); assert.equal(filtered.payable, 281.84)
  assert.equal(filtered.missingNet, true)
  assert.equal(buildTotals(details, [], periods, views, '', 'Inexistente').length, 0)
})
test('a legitimate zero invoice and reimbursement override are preserved', () => {
  const details = buildDetails([], [item], [], periods)
  const views = [{ id: 'v1', notes: JSON.stringify({ reimbursement: 0, summary: { gross: 281.84, invoice: 0, reimbursement: 90 } }) }]
  const total = buildTotals(details, [], periods, views)[0]
  assert.equal(total.net, 0); assert.equal(total.reimbursement, 0); assert.equal(total.companyPayment, -281.84)
})

test('recovering only invoice and date does not erase reimbursement from details', () => {
  const details = buildDetails([], [{ ...item, reimbursement: 25 }], [], [periods[0]])
  const total = buildTotals(details, [], [periods[0]], [{ id: 'v1', notes: JSON.stringify({ summary: { invoice: 1000, paymentDate: '2026-09-16' } }) }])[0]
  assert.equal(total.reimbursement, 25)
  assert.equal(total.net, 1000)
  assert.equal(total.payable, 306.84)
})

test('closing template imports one net amount and date per partner without duplicating totals', async () => {
  const XLSX = await import('xlsx')
  const workbook = createClosingTemplate()
  const partner = periods[0].partner
  workbook.Sheets['Pagamento Total'] = XLSX.utils.aoa_to_sheet([['Parceiro', 'TotalLiquidoAReceber', 'DataPagamento'], [partner, 0, 46280]])
  const summary = readClosingSummary(workbook, [partner]).get(partner)
  assert.deepEqual(summary, { net_amount: 0, payment_date: '2026-09-15' })
  const totals = buildTotals([], [], [{ ...periods[0], ...summary }], [])
  assert.equal(totals[0].net, 0)
  assert.equal(totals[0].paymentDate, '2026-09-15')
  XLSX.utils.sheet_add_aoa(workbook.Sheets['Pagamento Total'], [[partner, 10, '15/09/2026']], { origin: -1 })
  assert.throws(() => readClosingSummary(workbook, [partner]), /apenas uma linha/)
  assert.throws(() => readClosingSummary(createClosingTemplate(), [partner]), /confira parceiro/)
})

test('historical complement preserves zero and dates, skips blank reimbursements and rejects duplicate net values', async () => {
  const XLSX = await import('xlsx')
  const rows = [['Vendors/PERÍODO'], ['PERÍODO', '', '', '', '', '', '', 'TOTAL LÍQUIDO A RECEBER'], ['PERIODO', '', '', '', '', '', '', 153227.50999999998, '', '', '', '', 46281], ['PERIODO', 'Reembolso', '', '', '', '', 500, '', '', '', '', '', ''], ['ZERO', '', '', '', '', '', '', 0, '', '', '', '', 46280], ['FUTURO', '', '', '', '', '', '', '', '', '', '', '', 46301]]
  const workbook = { SheetNames: ['Pgto Total'], Sheets: { 'Pgto Total': XLSX.utils.aoa_to_sheet(rows) } }
  const result = readHistoricalPayments(workbook)
  assert.deepEqual(result, [{ period: 'PERIODO', invoice: 153227.51, paymentDate: '2026-09-16', sourceLine: 3 }, { period: 'ZERO', invoice: 0, paymentDate: '2026-09-15', sourceLine: 5 }])
  const total = buildTotals([], [], [{ id: 'period', label: 'PERIODO', partner: 'IMILE DELIVERY BRAZIL LTDA', financial_view_id: 'view' }], [{ id: 'view', notes: JSON.stringify({ summary: result[0] }) }])[0]
  assert.equal(total.net, 153227.51)
  assert.equal(total.gross, 153227.51)
  XLSX.utils.sheet_add_aoa(workbook.Sheets['Pgto Total'], [rows[2]], { origin: -1 })
  assert.throws(() => readHistoricalPayments(workbook), /Mais de um líquido/)
})

test('CNAB reads native Excel dates independently of display format and rejects invalid dates', async () => {
  const XLSX = await import('xlsx')
  for (const date1904 of [false, true]) {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['DROP', 'RESPONSÁVEL', 'TOTAL DROP', 'PIX', 'DATA PAGAMENTO', 'CPF/CNPJ'],
      ['TESTE', 'Responsavel', .01, 'teste@example.com', date1904 ? 44818 : 46280, '12345678901'],
      ['TESTE', 'Responsavel', .01, 'teste@example.com', '15/09/2026', '12345678901'],
      ['TESTE', 'Responsavel', .01, 'teste@example.com', '31/02/2026', '12345678901'],
    ])
    sheet.E2.z = 'm/d/yy'
    const workbook = XLSX.utils.book_new()
    workbook.Workbook = { WBProps: { date1904 } }
    XLSX.utils.book_append_sheet(workbook, sheet, 'Pagamentos')
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
    const result = await readCnabSpreadsheet({ arrayBuffer: async () => bytes })
    assert.deepEqual(result.payments.map(payment => payment.paymentDate), ['2026-09-15', '2026-09-15'])
    assert.equal(result.errors.length, 1)
    assert.equal(result.rowsFound, 3)
  }
})

test('Banco Inter CNAB reproduces the Excel layout, sequences and totals', () => {
  assert.equal(pixKeyType('financeiro@movidos.com.br'), '02')
  assert.equal(pixKeyType('22.944.549/0001-77'), '03')
  assert.equal(pixKeyType('(11) 99999-1111'), '01')
  assert.equal(pixKeyType('123e4567-e89b-12d3-a456-426614174000'), '04')
  const payments = prepareCnabPayments([
    { period: '33', partner: 'Patrícia', drop: 'VNM', responsible: 'Maria', receivable: 250, pix: 'financeiro@movidos.com.br', pixHolderName: 'Maria', paymentDate: '2026-09-16', document: '22.944.549/0001-77' },
    { period: '33', partner: 'Patrícia', drop: 'VNM', receivable: 1.84, paymentDate: '2026-09-16' },
    { period: '33', partner: 'Patrícia', drop: 'OUTRO', responsible: 'João', receivable: 48.16, pix: '(11) 99999-1111', paymentDate: '2026-09-17', document: '123.456.789-01' },
  ])
  assert.equal(payments.length, 2)
  assert.equal(payments[0].value, 251.84)
  const lines = createCnabInter(payments, new Date(2026, 8, 10, 14, 5, 6)).split('\r\n')
  assert.equal(lines.pop(), '')
  assert.equal(lines.length, 8)
  assert.ok(lines.every(line => line.length === 240))
  assert.equal(lines[0].slice(0, 8), '07700000')
  assert.equal(lines[0].slice(143, 151), '10092026')
  assert.equal(lines[0].slice(151, 157), '140506')
  assert.equal(lines[2].slice(8, 14), '00001A')
  assert.equal(lines[2].slice(93, 102), '16092026B')
  assert.equal(lines[2].slice(119, 134), '000000000025184')
  assert.equal(lines[3].slice(8, 18), '00002B02 2')
  assert.equal(lines[3].slice(18, 32), '22944549000177')
  assert.equal(lines[3].slice(127, 152), 'FINANCEIRO@MOVIDOS.COM.BR')
  assert.equal(lines[6].slice(17, 47), '000007000002000000000000030000')
  assert.equal(lines[7].slice(17, 29), '000001000008')
})

if (process.env.GENERATE_PDF_FIXTURES === '1') {
  await build({ entryPoints: ['src/financialReport.ts'], outfile: 'tmp/financial-tests/report.cjs', bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
  const { createClosingPdf } = await import(pathToFileURL(`${process.cwd()}/tmp/financial-tests/report.cjs`).href)
  const detail = { ...buildDetails([], [item], [], periods)[0], pix: '22.944.549/0001-77', paymentDate: '2026-09-16' }
  await writeFile('tmp/financial-tests/modelo-vnm.pdf', Buffer.from(createClosingPdf([detail], [], periods).output('arraybuffer')))
  const losses = Array.from({ length: 75 }, (_, index) => ({ ...loss(String(index), index % 2 ? 'PUDO Missing' : 'D2D Missing - não cobrei', 10.25), waybill: `6041025289${index.toString().padStart(3, '0')}`, label_code: `ETIQUETA-COMPRIDA-SEM-CORTAR-${index}`, bag_code: `D0803605-${index}`, seller: 'Nome de vendedor com várias palavras para verificar quebra de linha', received_at: '2026-08-05T13:25:00-03:00' }))
  const doc = createClosingPdf([detail, { ...detail, id: 'new', drop: 'NOVO' }], losses, periods)
  assert.ok(doc.getNumberOfPages() > 2)
  await writeFile('tmp/financial-tests/multiplas-paginas.pdf', Buffer.from(doc.output('arraybuffer')))
  console.log(`PDF fixtures: reference model and ${doc.getNumberOfPages()}-page overflow check.`)
}
