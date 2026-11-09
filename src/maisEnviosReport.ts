import { jsPDF } from 'jspdf'
import { maisEnviosSmartKey, maisEnviosSummaries, type MaisEnviosClosing } from './maisEnviosClosing.js'

export const maisEnviosMoney = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
export const maisEnviosValidityLabel = { valid: 'Sim', invalid: 'Nao', duplicate: 'Duplicidade', pending: 'Pendente' }
export const maisEnviosMarketHeaders = ['Periodo', 'Id', 'Cliente', 'Telefone', 'E-mail', 'Atendente', 'Codigo de Rastreio', 'Marketplace', 'Data de Criacao', 'Valido?']
export const maisEnviosPostingHeaders = ['Periodo', 'Etiqueta', 'Status', 'Remetente', 'Destinatario', 'Data Criacao', 'Data Postagem', 'Peso', 'Servico', 'Valor', 'Valido?', 'Smart']

export function createMaisEnviosPdf(closing: MaisEnviosClosing, smart: string) {
  const summary = maisEnviosSummaries(closing.rows, closing.period).find(row => maisEnviosSmartKey(row.smart) === maisEnviosSmartKey(smart))
  if (!summary) throw new Error('Smart nao encontrada neste fechamento.')
  const rows = closing.rows.filter(row => maisEnviosSmartKey(row.smart) === maisEnviosSmartKey(smart))
  if (rows.some(row => row.validity === 'pending')) throw new Error('Resolva a validacao da Smart antes de gerar o PDF.')
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  doc.setProperties({ title: `${smart} - ${closing.period}`, subject: 'Fechamento Mais Envios', creator: 'Sistema Movidos' })
  let y = 9
  const page = () => { doc.addPage(); y = 10 }
  const heading = (value: string, size: number) => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(size)
    const lines = doc.splitTextToSize(value, 194) as string[]
    doc.text(lines, 105, y + size * .35, { align: 'center' }); y += lines.length * size * .4 + 4
  }
  heading(smart, 15); heading(`PERIODO: ${closing.period}`, 10)
  const summaryWidths = [30, 10, 14, 15, 18, 16, 16, 17, 4, 14, 4, 16, 22]
  const summaryLine = (values: string[], widths: number[], bold: boolean, minimum: number) => {
    doc.setFontSize(6); doc.setFont('helvetica', bold ? 'bold' : 'normal')
    const lines = values.map((value, index) => doc.splitTextToSize(value || '', widths[index] - 2) as string[])
    const height = Math.max(minimum, Math.max(...lines.map(value => value.length)) * 2.5 + 4)
    if (y + height > 275) page()
    let x = 7
    widths.forEach((width, index) => {
      doc.setFillColor(255, 242, 0); doc.setDrawColor(85); doc.rect(x, y, width, height, 'FD')
      doc.text(lines[index], x + width / 2, y + 3.5, { align: 'center', lineHeightFactor: 1.15 }); x += width
    })
    y += height
  }
  summaryLine(['Smart', 'Objetos Marketplace', 'Postagem Paga', 'Resultado Final'], [30, 39, 50, 77], true, 9)
  summaryLine(['', 'Valor que a +Envios vai pagar para a Smart', 'Valor Total', '15% da Smart', '85% da +Envios', '85% - Objetos Marketplace'], [30, 39, 18, 16, 16, 77], true, 11)
  summaryLine([smart, String(summary.packages), 'pacotes x 0,50 =', maisEnviosMoney(summary.marketplaceCents),
    ...[summary.postingCents, summary.smartShareCents, summary.companyShareCents].map(value => summary.postingCents ? maisEnviosMoney(value) : ''),
    ...(summary.postingCents ? [maisEnviosMoney(summary.companyShareCents), '-', maisEnviosMoney(summary.marketplaceCents), '='] : ['', '', '', '']),
    maisEnviosMoney(summary.resultCents), summary.direction], summaryWidths, false, 12)
  y += 7
  const table = (title: string, headers: string[], data: string[][], weights: number[]) => {
    const widths = weights.map(weight => weight * 196 / weights.reduce((sum, item) => sum + item, 0))
    const draw = (values: string[], header = false) => {
      doc.setFont('helvetica', header ? 'bold' : 'normal'); doc.setFontSize(header ? 5.3 : 5)
      const wrapped = values.map((value, index) => doc.splitTextToSize(value || '-', widths[index] - 2) as string[])
      let offset = 0
      const total = Math.max(...wrapped.map(lines => lines.length))
      while (offset < total) {
        if (y + 6 > 282) { page(); tableHeader() }
        const capacity = Math.max(1, Math.floor((282 - y - 3) / 2.2))
        const count = Math.min(capacity, total - offset)
        const height = count * 2.2 + 3
        let x = 7
        widths.forEach((width, index) => {
          doc.setFillColor(...(header ? [217, 226, 243] : [255, 255, 255]) as [number, number, number]); doc.setDrawColor(175)
          doc.rect(x, y, width, height, 'FD')
          doc.text(wrapped[index].slice(offset, offset + count), x + 1, y + 3, { lineHeightFactor: 1.2 }); x += width
        })
        y += height; offset += count
      }
    }
    const tableHeader = () => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.text(title, 7, y + 4); y += 7
      draw(headers, true)
    }
    if (y > 245) page()
    tableHeader()
    for (const row of data) draw(row)
    if (!data.length) { doc.setFontSize(7); doc.text('Nenhum registro encontrado.', 8, y + 4); y += 8 }
    y += 7
  }
  table('POSTAGENS PAGAS', maisEnviosPostingHeaders, rows.filter(row => row.kind === 'posting').map(row => [closing.period, row.code, ...row.values.slice(1, 8), maisEnviosMoney(row.valueCents), maisEnviosValidityLabel[row.validity], row.smart]), [16, 20, 15, 20, 20, 19, 17, 8, 15, 13, 12, 21])
  table('OBJETOS MARKETPLACE', maisEnviosMarketHeaders, rows.filter(row => row.kind === 'marketplace').map(row => [closing.period, ...row.values.slice(0, 4), row.smart, row.code, row.values[6], row.createdAt, maisEnviosValidityLabel[row.validity]]), [16, 12, 21, 17, 24, 23, 24, 18, 19, 14])
  const pages = doc.getNumberOfPages()
  for (let index = 1; index <= pages; index++) { doc.setPage(index); doc.setFontSize(7); doc.setFont('helvetica', 'normal'); doc.text(`${index} / ${pages}`, 202, 291, { align: 'right' }) }
  return doc
}