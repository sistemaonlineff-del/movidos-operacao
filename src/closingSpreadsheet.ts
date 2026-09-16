import * as XLSX from 'xlsx'
import { normalizePartner, PARTNERS } from './dropOptions'
import { number, text } from './financialData'
import { parsePaymentDate } from './cnabSpreadsheet'

export function createClosingTemplate() {
  const workbook = XLSX.utils.book_new()
  const sheets = [
    ['Fechamento', [['Periodo', 'Parceiro', 'Drop', 'QuantidadePacote', 'CNPJReferencia'], ['', PARTNERS[0], '', '', 'MOVIDOS']]],
    ['Extravios', [['Periodo', 'Parceiro', 'Drop', 'Waybill', 'CodigoEtiqueta', 'Saca', 'Status', 'Seller', 'DataRecebimento', 'ValorExtravio', 'Obs', 'CNPJReferencia']]],
    ['Pagamento Total', [['Parceiro', 'TotalLiquidoAReceber', 'DataPagamento'], [PARTNERS[0], '', '']]],
  ] as const
  for (const [name, rows] of sheets) {
    const sheet = XLSX.utils.aoa_to_sheet(rows.map(row => [...row]))
    sheet['!cols'] = rows[0].map(() => ({ wch: 26 }))
    XLSX.utils.book_append_sheet(workbook, sheet, name)
  }
  return workbook
}

export function downloadClosingTemplate() {
  XLSX.writeFile(createClosingTemplate(), 'modelo-fechamento-financeiro.xlsx')
}

export function readHistoricalPayments(workbook: XLSX.WorkBook) {
  const sheet = workbook.Sheets['Pgto Total']
  if (!sheet) throw new Error('Aba Pgto Total ausente.')
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' })
  if (text(rows[1]?.[0]) !== 'PERÍODO' || text(rows[1]?.[7]) !== 'TOTAL LÍQUIDO A RECEBER') throw new Error('Cabeçalhos do histórico não reconhecidos.')
  const payments = new Map<string, { period: string; invoice: number; paymentDate: string; sourceLine: number }>()
  rows.slice(2).forEach((row, index) => {
    if (!text(row[7])) return
    const period = text(row[0])
    if (!period || typeof row[7] !== 'number' || !Number.isFinite(row[7])) throw new Error(`Líquido inválido na linha ${index + 3}.`)
    if (payments.has(period)) throw new Error(`Mais de um líquido preenchido para ${period}. Confira antes de importar.`)
    const rawDate = row[12]
    const decoded = typeof rawDate === 'number' ? XLSX.SSF.parse_date_code(rawDate, { date1904: workbook.Workbook?.WBProps?.date1904 }) : null
    const paymentDate = parsePaymentDate(decoded ? `${decoded.y}-${decoded.m}-${decoded.d}` : rawDate)
    if (!paymentDate) throw new Error(`Data inválida para ${period}.`)
    payments.set(period, { period, invoice: Math.round((row[7] + Number.EPSILON) * 100) / 100, paymentDate, sourceLine: index + 3 })
  })
  return [...payments.values()]
}

export function readClosingSummary(workbook: XLSX.WorkBook, partners: string[]) {
  const sheet = workbook.Sheets['Pagamento Total']
  if (!sheet) throw new Error('Baixe o modelo atualizado e preencha a aba Pagamento Total.')
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
  const result = new Map<string, { net_amount: number; payment_date: string }>()
  for (const row of rows) {
    if (!Object.values(row).some(value => text(value))) continue
    const partner = normalizePartner(text(row.Parceiro))
    const amount = text(row.TotalLiquidoAReceber).replace(/R\$\s*/g, '').replace(/\s/g, '')
    const numeric = amount.includes(',') ? amount.replace(/\./g, '').replace(',', '.') : amount
    let paymentDate = ''
    const input = row.DataPagamento
    if (input instanceof Date && Number.isFinite(input.getTime())) {
      paymentDate = parsePaymentDate(`${input.getFullYear()}-${input.getMonth() + 1}-${input.getDate()}`)
    } else if (typeof input === 'number') {
      const decoded = XLSX.SSF.parse_date_code(input, { date1904: workbook.Workbook?.WBProps?.date1904 })
      if (decoded) paymentDate = parsePaymentDate(`${decoded.y}-${decoded.m}-${decoded.d}`)
    } else paymentDate = parsePaymentDate(input)
    if (!partners.includes(partner) || !amount || !Number.isFinite(Number(numeric)) || !paymentDate) {
      throw new Error(`Pagamento Total: confira parceiro, total líquido e data de pagamento (${partner || 'sem parceiro'}).`)
    }
    if (result.has(partner)) throw new Error(`Pagamento Total: informe apenas uma linha para ${partner}.`)
    result.set(partner, { net_amount: number(row.TotalLiquidoAReceber), payment_date: paymentDate })
  }
  if (partners.some(partner => !result.has(partner))) throw new Error('Pagamento Total: informe total líquido e data para cada parceiro do fechamento.')
  return result
}