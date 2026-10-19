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
const { buildDetails, buildTotals, closingRegistration, closingOperators, closingWindow, allocateClosingPackages, paymentTotalTarget, lossClass, lossesFor, number, splitLosses, lossEditorValues, lossEventPayload, lossBatchPayloads } = await import(pathToFileURL(`${process.cwd()}/tmp/financial-tests/data.mjs`).href)
const { createCnabInter, pixKeyType, prepareCnabPayments } = await import(pathToFileURL(`${process.cwd()}/tmp/financial-tests/cnab.mjs`).href)
await build({ entryPoints: ['src/routeImport.ts'], outfile: 'tmp/financial-tests/routes.mjs', bundle: true, platform: 'node', format: 'esm' })
const { routeImportPlan } = await import(pathToFileURL(`${process.cwd()}/tmp/financial-tests/routes.mjs`).href)
test('route reimport fills only blank CEPs and preserves different streets with the same CEP', () => {
  const first = { id: 'one', street: 'Rua Um', neighborhood: 'Centro', city: 'Suzano', zone: 'Leste', route: '1', postal_code: null }
  const second = { ...first, id: 'two', street: 'Rua Dois', postal_code: '12345-000' }
  const plan = routeImportPlan([first, second], [{ ...first, postal_code: '12345-000' }, { ...second, postal_code: '99999-000' }, { ...first, id: undefined, street: 'Rua Três', postal_code: '12345-000' }])
  assert.deepEqual(plan.fills, [{ id: 'one', previous: null, postal_code: '12345-000' }])
  assert.equal(plan.inserts.length, 1); assert.equal(plan.skipped, 1)
  assert.throws(() => routeImportPlan([first], [{ ...first, postal_code: '12345-000' }, { ...first, postal_code: '99999-000' }]), /CEPs diferentes/)
  assert.equal(first.postal_code, null); assert.equal(second.postal_code, '12345-000')
})
const periods = [{ id: 'p1', label: '33. 1Q DE AGOSTO', partner: 'IMILE DELIVERY BRAZIL LTDA', financial_view_id: 'v1', net_amount: null }, { id: 'p2', label: '33. 1Q DE AGOSTO', partner: 'J&T EXPRESS LTDA', financial_view_id: 'v1', net_amount: null }]
const item = { id: 'i1', financial_period_id: 'p1', drop_name_snapshot: 'VNM', quantity_packages: 2168, unit_value: .13, reimbursement: 0 }
const loss = (id, status, amount, period = 'p1') => ({ id, financial_period_id: period, period_label: periods[0].label, drop_name_snapshot: 'VNM', status, amount })

test('operation dates select historical owners and require an exact manual package split at transition', () => {
  const davi = { id: 'davi', name: 'MGC 5', partner: periods[0].partner, responsible: 'Davi', monthly_value: .25, pix_key: '00123', operation_started_at: '2026-08-01', operation_ended_at: '2026-10-10', is_active: false }
  const gustavo = { ...davi, id: 'gustavo', responsible: 'Gustavo', monthly_value: .5, pix_key: '99999', operation_started_at: '2026-10-11', operation_ended_at: null, is_active: true }
  const operators = [gustavo, davi]
  const select = (start, end, rows = operators) => closingOperators('MGC 5', periods[0].partner, rows, start, end)
  assert.deepEqual(select('2026-09-16', '2026-09-30').map(row => row.registration_snapshot.responsible), ['Davi'])
  assert.deepEqual(select('2026-10-16', '2026-10-31').map(row => row.registration_snapshot.responsible), ['Gustavo'])
  const transition = select('2026-10-01', '2026-10-15')
  assert.deepEqual(transition.map(row => row.registration_snapshot.responsible), ['Davi', 'Gustavo'])
  assert.throws(() => allocateClosingPackages(100, transition), /cada responsavel/)
  assert.throws(() => allocateClosingPackages(100, transition, [70, 20]), /soma/)
  for (const values of [['', 100], [-1, 101], [1.5, 98.5], ['invalid', 0]]) assert.throws(() => allocateClosingPackages(100, transition, values), /quantidade/)
  const split = allocateClosingPackages(100, transition, [70, 30])
  assert.deepEqual(split.map(row => [row.quantity_packages, row.unit_value]), [[70, .25], [30, .5]])
  assert.equal(allocateClosingPackages(100, transition, [0, 100])[0].quantity_packages, 0)
  assert.throws(() => select('2026-10-01', '2026-10-15', [davi, { ...gustavo, operation_started_at: '2026-10-10' }]), /sobrepostas/)
  assert.throws(() => select('2026-10-01', '2026-10-15', [davi, { ...gustavo, operation_started_at: '2026-10-12' }]), /sem responsavel/)
  assert.throws(() => select('2026-07-01', '2026-07-15'), /Nenhum cadastro/)
  assert.throws(() => select('2026-10-16', '2026-10-31', [{ ...gustavo, monthly_value: null }]), /valor acordado/)
  assert.throws(() => closingWindow('2026-02-16', '2026-02-30'), /datas/)
  assert.throws(() => closingWindow('2026-10-01', '2026-10-31'), /quinzena completa/)
  assert.deepEqual(closingWindow('2028-02-16', '2028-02-29'), { start: '2028-02-16', end: '2028-02-29' })
  assert.throws(() => closingWindow('2026-10-01', '2026-10-15', '40. 1Q DE SETEMBRO'), /titulo/)
  assert.throws(() => closingWindow('2026-10-01', '2026-10-15', '40. 2Q DE OUTUBRO'), /titulo/)
  assert.throws(() => closingWindow('2026-10-01', '2026-10-15', '40. 1Q DE OUTUBRO 2025'), /titulo/)
  assert.equal(closingWindow('2026-03-01', '2026-03-15', '1Q DE MARÇO').start, '2026-03-01')
  assert.equal(split[0].registration_snapshot.closingStart, '2026-10-01')
})

test('split owners keep their packages, rates and assigned losses separate after manual edits', () => {
  const items = [{ ...item, id: 'davi-item', quantity_packages: 70, unit_value: .25, registration_snapshot: { dropId: 'davi', responsible: 'Davi', pix: '001' } }, { ...item, id: 'gustavo-item', quantity_packages: 30, unit_value: .5, registration_snapshot: { dropId: 'gustavo', responsible: 'Gustavo', pix: '002' } }]
  const occurrences = [{ ...loss('davi-loss', 'PUDO Missing', 2), drop_id: 'davi' }, { ...loss('gustavo-loss', 'D2D Missing', 3), drop_id: 'gustavo' }]
  const details = buildDetails([], items, occurrences, periods)
  assert.deepEqual(details.map(row => [row.responsible, row.subtotal, row.loss, row.receivable]), [['Davi', 17.5, 2, 15.5], ['Gustavo', 15, 3, 12]])
  assert.equal(lossesFor(details[0], occurrences, periods)[0].id, 'davi-loss')
  assert.equal(lossesFor(details[1], occurrences, periods).length, 1)
  const history = [{ id: 'edit-davi', financial_period_id: 'p1', drop_id: 'davi', drop_name_snapshot: item.drop_name_snapshot, responsible: 'Davi editado', package_quantity: 70, amount: .3, subtotal: 21, loss_amount: 2, total_receivable: 19, observation: JSON.stringify({ movidosClosing: { sourceItemId: 'davi-item' } }) }]
  const edited = buildDetails(history, items, occurrences, periods)
  assert.equal(edited.length, 2)
  assert.deepEqual(edited.find(row => row.dropId === 'gustavo'), details[1])
})

test('import captures current registration once, preserves zero and refuses ambiguous partners', () => {
  const davi = { id: 'davi-id', name: 'MGC 5', partner: periods[0].partner, responsible: 'Davi', pix_key: '00123', email: 'davi@example.test', cpf: '00123456789', monthly_value: .25 }
  const saved = closingRegistration('mgc 5', periods[0].partner, [davi], .13)
  const old = structuredClone(saved)
  davi.responsible = 'Gustavo'; davi.pix_key = '999'; davi.monthly_value = .5
  assert.deepEqual(saved, old)
  assert.equal(saved.unit_value, .25); assert.equal(saved.registration_snapshot.responsible, 'Davi')
  const next = closingRegistration('MGC 5', periods[0].partner, [davi], .13)
  assert.equal(next.unit_value, .5); assert.equal(next.registration_snapshot.responsible, 'Gustavo')
  assert.equal(closingRegistration('MGC 5', periods[0].partner, [{ ...davi, monthly_value: 0 }], .13).unit_value, 0)
  assert.equal(closingRegistration('MGC 5', periods[0].partner, [{ ...davi, monthly_value: null }], .13).unit_value, .13)
  assert.equal(closingRegistration('MGC 5', periods[1].partner, [davi], .13).registration_snapshot.dropId, null)
  assert.throws(() => closingRegistration('MGC 5', periods[0].partner, [davi, { ...davi, id: 'other' }]), /ambiguo/)
})

test('closing snapshots never follow registration edits, removal or replacement', () => {
  const snapshot = { dropId: 'davi-id', responsible: 'Davi', pix: '00123456789', pixHolderName: 'Davi', document: '00123456789', email: 'davi@example.test' }
  const saved = { ...item, registration_snapshot: snapshot }
  const original = buildDetails([], [saved], [], periods)[0]
  const replacement = { id: 'gustavo-id', name: item.drop_name_snapshot, partner: periods[0].partner, responsible: 'Gustavo', pix_key: '99999999999', monthly_value: 9999, email: 'gustavo@example.test' }
  assert.deepEqual(buildDetails([], [saved], [], periods, [replacement])[0], original)
  assert.deepEqual(buildDetails([], [saved], [], periods, [{ ...replacement, id: 'davi-id', name: 'RENAMED', is_active: false }])[0], original)
  for (const field of ['responsible', 'pix', 'pixHolderName', 'document', 'email', 'dropId']) assert.equal(original[field], snapshot[field], field)
  const legacy = buildDetails([], [item], [], periods, [replacement])[0]
  assert.equal(legacy.responsible, ''); assert.equal(legacy.pix, ''); assert.equal(legacy.dropId, null)
  const edited = { id: 'edit', financial_period_id: 'p1', drop_name_snapshot: 'VNM', responsible: '', pix_key: '', observation: JSON.stringify({ movidosClosing: { sourceItemId: item.id } }) }
  const result = buildDetails([edited], [saved], [], periods, [replacement])[0]
  assert.equal(result.responsible, ''); assert.equal(result.pix, ''); assert.equal(result.email, snapshot.email)
})

test('payment details workbook matches table columns and totals with numeric amounts and literal PIX', async () => {
  await build({ entryPoints: ['src/excelDownload.ts'], outfile: 'tmp/financial-tests/excel.cjs', bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
  const { createPaymentDetailsWorkbook } = await import(pathToFileURL(`${process.cwd()}/tmp/financial-tests/excel.cjs`).href)
  const XLSX = await import('xlsx')
  const rows = [{ referenceCnpj: 'MOVIDOS', period: '34. 2Q DE AGOSTO', drop: '=FORMULA()', responsible: 'Pessoa', partner: periods[0].partner, packages: 10, unit: .13, subtotal: 1.3, w2d: .2, d2d: 0, loss: .2, reimbursement: 0, receivable: 1.1, paymentDate: '2026-09-17', pix: '00123456789' }]
  const workbook = await createPaymentDetailsWorkbook(rows)
  const sheet = XLSX.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' }).Sheets['Pagamento Detalhes']
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
  assert.deepEqual(matrix[0], ['CNPJ de referência', 'Período', 'DROP', 'Responsável', 'Parceiro', 'Total pacote', 'Valor acordado', 'Subtotal', 'Extravio W2D', 'Extravio D2D', 'Total extravio', 'Reembolso iMile', 'Total a receber', 'Data pagamento', 'PIX'])
  assert.deepEqual(matrix[2], ['MOVIDOS', rows[0].period, '=FORMULA()', 'Pessoa', periods[0].partner, 10, .13, 1.3, .2, 0, .2, 0, 1.1, '17/09/2026', '00123456789'])
  assert.equal(matrix[1][5], 10); assert.equal(matrix[1][6], ''); assert.equal(matrix[1][12], 1.1)
  assert.equal(sheet.C3.f, undefined); assert.equal(sheet.O3.t, 's'); assert.equal(sheet.M3.t, 'n')
  assert.equal(XLSX.utils.sheet_to_json((await createPaymentDetailsWorkbook([])).Sheets['Pagamento Detalhes'], { header: 1 }).length, 2)
})

test('bulk loss plan changes only marked fields, validates the entire selection and preserves separate identities', () => {
  const rows = [ { ...loss('one', 'PUDO Missing', 10), updated_at: 'version-one', partner: periods[0].partner, observation: 'Keep one', waybill: 'WB-1' }, { ...loss('two', 'D2D Missing', 20, 'p2'), updated_at: 'version-two', partner: periods[1].partner, observation: 'Keep two', waybill: 'WB-2' } ]
  const snapshot = structuredClone(rows)
  const plan = lossBatchPayloads(rows, { status: 'PUDO Missing - não cobrei' }, periods, [])
  assert.deepEqual(plan.map(change => change.payload), [{ status: 'PUDO Missing - não cobrei' }, { status: 'PUDO Missing - não cobrei' }])
  assert.deepEqual(plan.map(change => change.original.id), ['one', 'two'])
  assert.deepEqual(lossBatchPayloads(rows, { amount: 0, observation: '' }, periods, []).map(change => change.payload), [{ amount: 0, observation: null }, { amount: 0, observation: null }])
  assert.equal(lossBatchPayloads(rows, { partner: periods[0].partner }, periods, [])[1].payload.financial_period_id, 'p1')
  assert.throws(() => lossBatchPayloads(rows, {}, periods, []), /ao menos um campo/)
  assert.throws(() => lossBatchPayloads(rows, { id: 'no' }, periods, []), /não permitido/)
  assert.throws(() => lossBatchPayloads([...rows, rows[0]], { status: 'Novo' }, periods, []), /repetidos/)
  assert.throws(() => lossBatchPayloads([rows[0], { ...rows[1], updated_at: null }], { status: 'Novo' }, periods, []), /sem versão/)
  assert.throws(() => lossBatchPayloads(rows, { period_label: 'INEXISTENTE' }, periods, []), /fechamento existente/)
  assert.deepEqual(rows, snapshot)
})

test('loss editor preserves metadata and timestamps, rebinds changed identities and validates new occurrences', () => {
  const original = { ...loss('loss1', 'PUDO Missing', 10), partner: null, period_label: null, drop_id: 'original-drop', waybill: ' WB-1 ', received_at: '2026-09-16T23:30:42.123-03:00', legacy_id: 42, is_active: true, created_by: 'creator', updated_at: 'version-1' }
  const draft = lossEditorValues(original, periods)
  const unchanged = lossEventPayload(draft, original, periods, [])
  for (const field of ['financial_period_id', 'partner', 'period_label', 'drop_id', 'received_at', 'waybill']) assert.equal(unchanged[field], original[field], field)
  assert.equal(unchanged.amount, 10)
  for (const field of ['id', 'legacy_id', 'created_by', 'updated_at', 'is_active']) assert.equal(Object.hasOwn(unchanged, field), false, field)
  const dropRows = [{ id: 'drop-jt', name: 'NOVO', partner: periods[1].partner }, { id: 'drop-imile', name: 'NOVO', partner: periods[0].partner }]
  const changed = lossEventPayload({ ...draft, partner: periods[1].partner, drop_name_snapshot: 'NOVO', waybill: 'WB-2', label_code: 'ETQ', bag_code: 'SACA', seller: 'LOJA', status: 'D2D Missing', amount: '23,45', observation: 'Revisto', received_at: '2026-09-15T14:35:20' }, original, periods, dropRows)
  assert.equal(changed.financial_period_id, 'p2'); assert.equal(changed.drop_id, 'drop-jt')
  assert.equal(changed.amount, 23.45); assert.equal(changed.received_at, new Date('2026-09-15T14:35:20').toISOString())
  for (const [field, value] of Object.entries({ waybill: 'WB-2', label_code: 'ETQ', bag_code: 'SACA', seller: 'LOJA', status: 'D2D Missing', observation: 'Revisto' })) assert.equal(changed[field], value)
  assert.equal(lossEventPayload({ ...draft, amount: 0, received_at: '' }, original, periods, []).received_at, null)
  const newDraft = { ...draft, received_at: '', amount: 0 }
  const added = lossEventPayload(newDraft, null, periods, [])
  assert.equal(added.financial_period_id, 'p1'); assert.equal(added.drop_id, null); assert.equal(added.amount, 0)
  assert.equal(lossesFor({ periodId: 'p1', drop: 'VNM' }, [added], periods).length, 1)
  assert.equal(lossesFor({ periodId: 'p2', drop: 'VNM' }, [added], periods).length, 0)
  assert.throws(() => lossEventPayload({ ...newDraft, period_label: '' }, null, periods, []), /Preencha/)
  assert.throws(() => lossEventPayload({ ...newDraft, period_label: 'INEXISTENTE' }, null, periods, []), /fechamento existente/)
  assert.throws(() => lossEventPayload(newDraft, null, [...periods, { ...periods[0], id: 'duplicate' }], []), /ambíguos/)
  for (const amount of ['', 'abc', Infinity, '1000000000000']) assert.throws(() => lossEventPayload({ ...newDraft, amount }, null, periods, []), /valor/)
  assert.throws(() => lossEventPayload({ ...newDraft, received_at: 'invalid' }, null, periods, []), /data/)
  const legacy = { ...original, financial_period_id: null, partner: 'Eduardo', period_label: 'HISTORICO' }
  assert.equal(lossEventPayload({ ...lossEditorValues(legacy, []), observation: 'Nova' }, legacy, [], []).financial_period_id, null)
})

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
test('manual proportional payments remain separate without replacing items or reallocating their losses', () => {
  const occurrences = [loss('existing-loss', 'PUDO Missing', 20)]
  const original = buildDetails([], [item], occurrences, periods)[0]
  const history = [{ id: 'manual1', financial_period_id: 'p1', drop_name_snapshot: item.drop_name_snapshot, responsible: 'Nova pessoa', package_quantity: 50, amount: .13, subtotal: 6.5, loss_amount: 2, reimbursement: 0, total_receivable: 4.5, observation: JSON.stringify({ movidosClosing: { manualEntry: true, referenceCnpj: 'BELLY', w2d: 2, d2d: 0 } }) }]
  const details = buildDetails(history, [item], occurrences, periods)
  assert.equal(details.length, 2)
  assert.deepEqual(details.find(row => row.id === item.id), original)
  const added = details.find(row => row.id === 'manual1')
  assert.equal(added.sourceItemId, undefined)
  assert.equal(added.referenceCnpj, 'BELLY')
  assert.equal(added.responsible, 'Nova pessoa')
  assert.equal(added.receivable, 4.5)
  assert.equal(added.w2d, 2)
  const totals = buildTotals(details, occurrences, [{ ...periods[0], net_amount: 1000 }], [])
  assert.equal(totals[0].net, 1000)
  assert.equal(totals[0].payable, original.receivable)
  assert.equal(totals.find(row => row.referenceCnpj === 'BELLY').payable, 4.5)
  assert.equal(totals.find(row => row.referenceCnpj === 'BELLY').net, null)
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

test('manual payment totals target one source without duplicating legacy net or crossing partners', () => {
  const partner = periods[0].partner
  const legacyPeriods = [{ ...periods[0], partner: 'Eduardo' }, { ...periods[0], id: 'p3', partner: 'Felipe' }]
  const view = { id: 'v1', notes: JSON.stringify({ source: 'preserved', summary: { invoice: 0, paymentDate: '2026-09-20', reimbursement: 12 } }) }
  assert.equal(paymentTotalTarget([periods[0]], [view], periods[0].label, partner).table, 'financial_periods')
  assert.equal(paymentTotalTarget(legacyPeriods, [view], periods[0].label, partner).table, 'financial_views')
  assert.equal(paymentTotalTarget([...legacyPeriods, periods[1]], [view], periods[0].label, partner), null)
  assert.equal(paymentTotalTarget(legacyPeriods.map(row => ({ ...row, net_amount: 10 })), [view], periods[0].label, partner), null)
  assert.equal(paymentTotalTarget(legacyPeriods, [], periods[0].label, partner), null)
  const detail = { period: periods[0].label, partner, receivable: 25, paymentDate: '2026-09-01' }
  const total = buildTotals([detail], [loss('manual', 'PUDO Missing', 10)], legacyPeriods, [view])[0]
  assert.equal(total.net, 0); assert.equal(total.gross, 10); assert.equal(total.companyPayment, -25)
  assert.equal(total.paymentDate, '2026-09-20'); assert.equal(total.reimbursement, 12)
  const updated = buildTotals([detail], [], [{ ...periods[0], net_amount: 1200.5, payment_date: '2026-09-21' }], [view])[0]
  assert.equal(updated.net, 1200.5); assert.equal(updated.paymentDate, '2026-09-21')
})

test('closing template imports one net amount and date per partner without duplicating totals', async () => {
  const XLSX = await import('xlsx')
  const workbook = createClosingTemplate()
  const partner = periods[0].partner
  assert.deepEqual(XLSX.utils.sheet_to_json(workbook.Sheets['Pagamento Total'], { header: 1 })[0], ['Periodo', 'Parceiro', 'TotalLiquidoAReceber', 'DataPagamento', 'CNPJReferencia'])
  const populated = createClosingTemplate('33. 1Q DE AGOSTO')
  assert.equal(populated.Sheets['Pagamento Total'].A2.v, '33. 1Q DE AGOSTO')
  assert.equal(populated.Sheets.Fechamento.A2.v, '33. 1Q DE AGOSTO')
  workbook.Sheets['Pagamento Total'] = XLSX.utils.aoa_to_sheet([['Parceiro', 'TotalLiquidoAReceber', 'DataPagamento'], [partner, 0, 46280]])
  const summary = readClosingSummary(workbook, [partner]).get(partner)
  assert.deepEqual(summary, { net_amount: 0, payment_date: '2026-09-15' })
  const totals = buildTotals([], [], [{ ...periods[0], ...summary }], [])
  assert.equal(totals[0].net, 0)
  assert.equal(totals[0].paymentDate, '2026-09-15')
  XLSX.utils.sheet_add_aoa(workbook.Sheets['Pagamento Total'], [[partner, 10, '15/09/2026']], { origin: -1 })
  assert.throws(() => readClosingSummary(workbook, [partner]), /apenas uma linha/)
  assert.throws(() => readClosingSummary(createClosingTemplate(), [partner]), /confira parceiro/)
  workbook.Sheets['Pagamento Total'] = XLSX.utils.aoa_to_sheet([['Periodo', 'Parceiro', 'TotalLiquidoAReceber', 'DataPagamento'], ['33. 1Q DE AGOSTO', partner, 0, 46280]])
  assert.deepEqual(readClosingSummary(workbook, [partner], '33. 1Q DE AGOSTO').get(partner), summary)
  assert.throws(() => readClosingSummary(workbook, [partner], '34. 2Q DE AGOSTO'), /não corresponde/)
  workbook.Sheets['Pagamento Total'].A2.v = ''
  assert.deepEqual(readClosingSummary(workbook, [partner], '33. 1Q DE AGOSTO').get(partner), summary)
})

test('closing totals keep BELLY and MOVIDOS separate for the same fortnight and partner', async () => {
  const XLSX = await import('xlsx')
  const partner = periods[0].partner
  const workbook = createClosingTemplate('35. 1Q DE SETEMBRO')
  workbook.Sheets['Pagamento Total'] = XLSX.utils.aoa_to_sheet([['Parceiro','TotalLiquidoAReceber','DataPagamento','CNPJReferencia'],[partner,100,'12/10/2026','MOVIDOS'],[partner,200,'13/10/2026','BELLY']])
  const groups = ['MOVIDOS','BELLY'].map(referenceCnpj => ({partner, referenceCnpj}))
  const summary = readClosingSummary(workbook, groups)
  const scoped = groups.map((group,index) => ({...periods[0],id:`ref${index}`,reference_cnpj:group.referenceCnpj,...summary.get(`${partner}|${group.referenceCnpj}`)}))
  const totals = buildTotals([],[],scoped,[])
  assert.deepEqual(totals.map(row => [row.referenceCnpj,row.net]), [['MOVIDOS',100],['BELLY',200]])
  assert.equal(paymentTotalTarget(scoped,[],scoped[0].label,partner,'BELLY').record.id,'ref1')
  workbook.Sheets['Pagamento Total'].D2.v = ''
  assert.throws(()=>readClosingSummary(workbook,groups),/CNPJReferencia/)
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

test('CNAB accepts absent date and document columns without accepting malformed supplied dates', async () => {
  const XLSX = await import('xlsx')
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['DROP', 'RESPONSAVEL', 'TOTAL DROP', 'PIX'], ['DROP', 'Pessoa', 10, 'test@example.com']]), 'Pagamentos')
  const result = await readCnabSpreadsheet({ arrayBuffer: async () => XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) })
  assert.equal(result.errors.length, 0)
  assert.equal(result.payments[0].paymentDate, '')
  assert.equal(result.payments[0].document, '')
  const lines = createCnabInter(result.payments, new Date(2026, 9, 12)).split('\r\n')
  assert.equal(lines[2].slice(93, 101), '12102026')
  assert.equal(lines[3].slice(17, 32), '000000000000000')
  result.payments[0].pix = '12345678901'
  assert.equal(createCnabInter(result.payments).split('\r\n')[3].slice(17, 32), '100012345678901')
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
