import { DataRow, date, number, paymentDetailFields, round } from './financialData'

export async function createPaymentDetailsWorkbook(rows: DataRow[]) {
  const XLSX = await import('xlsx')
  const workbook = XLSX.utils.book_new()
  const total = paymentDetailFields.map(([field, , type], index) => index === 0
    ? `Total filtrado · ${rows.length} registro(s)`
    : type === 'number' && field !== 'unit' ? round(rows.reduce((sum, row) => sum + number(row[field]), 0)) : '')
  const sheet = XLSX.utils.aoa_to_sheet([
    paymentDetailFields.map(([, title]) => title), total,
    ...rows.map(row => paymentDetailFields.map(([field, , type]) => type === 'number'
      ? number(row[field]) : type === 'date' ? date(row[field]) : String(row[field] || '—'))),
  ])
  sheet['!cols'] = paymentDetailFields.map(([field, title]) => ({ wch: ['drop', 'partner', 'pix', 'responsible'].includes(field) ? 32 : Math.max(20, title.length + 2) }))
  sheet['!merges'] = [{ s: { r: 1, c: 0 }, e: { r: 1, c: 4 } }]
  sheet['!autofilter'] = { ref: `A1:O${rows.length + 2}` }
  for (let rowIndex = 1; rowIndex <= rows.length + 1; rowIndex++) {
    paymentDetailFields.forEach(([field, , type], columnIndex) => {
      const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })]
      if (cell?.t === 'n' && type === 'number') cell.z = field === 'packages' ? '#,##0' : '"R$" #,##0.00'
    })
  }
  XLSX.utils.book_append_sheet(workbook, sheet, 'Pagamento Detalhes')
  return workbook
}

export async function downloadPaymentDetailsExcel(rows: DataRow[]) {
  const XLSX = await import('xlsx')
  XLSX.writeFile(await createPaymentDetailsWorkbook(rows), 'pagamento-detalhes.xlsx')
}

export async function downloadExcel(filename: string, sheetName: string, rows: Record<string, unknown>[]) {
  const XLSX = await import('xlsx')
  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.json_to_sheet(rows)
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName.slice(0, 31))
  XLSX.writeFile(workbook, filename)
}
