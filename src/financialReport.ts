import { jsPDF } from 'jspdf'
import { DataRow, date, decimal, key, lossesFor, number, text } from './financialData'

type Column = { label: string; width: number; numeric?: boolean }
const blue: [number, number, number] = [149, 179, 215]
const orange: [number, number, number] = [230, 108, 0]
const closingColumns: Column[] = [
  ['PERÍODO', 22], ['DROP', 13], ['PARCEIRO', 18], ['TIPO PACOTE', 18], ['TOTAL PACOTE', 17], ['VALOR ACORDADO', 18], ['SUBTOTAL', 20], ['EXTRAVIO W2D', 17], ['EXTRAVIO D2D', 17], ['SUBTOTAL DE EXTRAVIO', 19], ['REEMBOLSO IMILE', 17], ['TOTAL A RECEBER', 20], ['DATA DO PAGAMENTO', 20], ['PIX', 25],
].map(([label, width], index) => ({ label: String(label), width: Number(width) * 277 / 261, numeric: index >= 4 && index <= 11 }))
const lossColumns: Column[] = [
  ['PERÍODO', 24], ['Scan Station\nDrop', 16], ['Waybill No.\nCódigo pacote', 28], ['Núm. Etiqueta Envio\nCódigo da etiqueta', 30], ['Barcode\nSaca', 23], ['Status\nStatus', 39], ['Seller Name\nSeller', 27], ['Receive Time\nHorário de recebimento', 29], ['Valor\nValor', 20],
].map(([label, width], index) => ({ label: String(label), width: Number(width), numeric: index === 8 }))

export function createClosingPdf(rows: DataRow[], losses: DataRow[], periods: DataRow[]) {
  if (!rows.length) throw new Error('Selecione pelo menos um fechamento para gerar o PDF.')
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  doc.setProperties({ title: 'Fechamento por DROP - iMile', subject: 'Fechamento financeiro e extravios por DROP', creator: 'Sistema Movidos' })
  const groups = new Map<string, DataRow[]>()
  rows.forEach(row => { const identity = `${row.periodId ?? row.period}|${key(row.partner)}|${key(row.drop)}`; groups.set(identity, [...(groups.get(identity) ?? []), row]) })
  let y = 8
  function title(value: string, width: number, color: [number, number, number]) {
    doc.setFillColor(...color); doc.rect(8, y, width, 10, 'F')
    doc.setFont('helvetica', 'bolditalic'); doc.setFontSize(9); doc.setTextColor(0)
    doc.text(value, 8 + width / 2, y + 6.4, { align: 'center' }); y += 10
  }
  function cells(values: string[], columns: Column[], fill: [number, number, number], header = false) {
    doc.setFont('helvetica', header ? 'bold' : 'normal'); doc.setFontSize(header ? 6 : 6.6)
    const wrapped = values.map((value, index) => doc.splitTextToSize(value || '-', columns[index].width - 2.4) as string[])
    const height = Math.max(header ? 14 : 5, Math.max(...wrapped.map(lines => lines.length)) * 2.7 + 3)
    if (y + height > 196) return false
    let x = 8
    columns.forEach((column, index) => {
      doc.setFillColor(...fill); doc.rect(x, y, column.width, height, 'F'); doc.setTextColor(0)
      const align = header ? 'center' : column.numeric ? 'right' : 'left'
      doc.text(wrapped[index], align === 'center' ? x + column.width / 2 : align === 'right' ? x + column.width - 1.2 : x + 1.2, y + 3, { align, lineHeightFactor: 1.12 })
      x += column.width
    })
    y += height
    return true
  }
  function nextPage() { doc.addPage(); y = 8 }
  function lossHeader(continuation = false) {
    title(continuation ? 'Extravio por DROP (continuação)' : 'Extravio por DROP', 236, orange)
    cells(lossColumns.map(column => column.label), lossColumns, orange, true)
  }
  let groupIndex = 0
  for (const group of groups.values()) {
    if (groupIndex++) nextPage()
    title('Fechamento por DROP - iMile', 277, blue)
    cells(closingColumns.map(column => column.label), closingColumns, blue, true)
    for (const row of group) {
      const values = [row.period, row.drop, row.partner, row.packageType || '', number(row.packages).toLocaleString('pt-BR'), ...['unit', 'subtotal', 'w2d', 'd2d', 'loss', 'reimbursement', 'receivable'].map(field => decimal(row[field])), date(row.paymentDate), row.pix || '']
      if (!cells(values, closingColumns, [220, 230, 241])) {
        nextPage(); title('Fechamento por DROP - iMile (continuação)', 277, blue)
        cells(closingColumns.map(column => column.label), closingColumns, blue, true)
        cells(values, closingColumns, [220, 230, 241])
      }
    }
    y += 3
    if (y > 165) nextPage()
    lossHeader()
    const related = lossesFor(group[0], losses, periods)
    let index = 0
    for (const loss of related) {
      const received = loss.received_at ? new Date(loss.received_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : ''
      const values = [group[0].period, text(loss.drop_name_snapshot), text(loss.waybill), text(loss.label_code), text(loss.bag_code), text(loss.status), text(loss.seller), received, decimal(loss.amount)]
      const fill: [number, number, number] = index++ % 2 ? [255, 255, 255] : [255, 245, 232]
      if (!cells(values, lossColumns, fill)) { nextPage(); lossHeader(true); cells(values, lossColumns, fill) }
    }
    if (y + 7 > 196) { nextPage(); lossHeader(true) }
    doc.setFillColor(220, 238, 243); doc.rect(8, y, 236, 6, 'F')
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(0)
    doc.text(related.length ? 'TOTAL DE EXTRAVIOS' : 'TOTAL DE EXTRAVIOS - sem ocorrências', 10, y + 4)
    doc.setTextColor(210, 0, 0); doc.text(decimal(related.reduce((sum, row) => sum + number(row.amount), 0)), 242, y + 4, { align: 'right' })
  }
  const count = doc.getNumberOfPages()
  for (let page = 1; page <= count; page++) { doc.setPage(page); doc.setTextColor(100); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.text(`${page} / ${count}`, 285, 204, { align: 'right' }) }
  return doc
}
export async function downloadClosingPdf(rows: DataRow[], losses: DataRow[], periods: DataRow[]) {
  const doc = createClosingPdf(rows, losses, periods)
  const name = rows.length === 1 ? `${rows[0].drop}_${rows[0].period}` : 'Fechamento_por_DROP'
  await doc.save(`${name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}.pdf`, { returnPromise: true })
}
