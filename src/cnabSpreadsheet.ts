import type { CnabPayment } from './cnabInter'

const labels = ['DROP', 'RESPONSAVEL', 'TOTAL DROP', 'PIX', 'DATA PAGAMENTO', 'CPF CNPJ'] as const
const normalize = (value: unknown) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
const value = (input: unknown) => {
  const source = String(input ?? '').replace(/R\$/gi, '').replace(/\s/g, '')
  const normalized = source.includes(',') ? source.replace(/\./g, '').replace(',', '.') : source
  return Number(normalized)
}
const date = (input: unknown) => {
  const source = String(input ?? '').trim()
  const match = source.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (match) return `${match[3].length === 2 ? `20${match[3]}` : match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`
  const iso = source.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  return iso ? `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}` : ''
}

export type CnabSpreadsheetResult = { payments: CnabPayment[]; rowsFound: number; errors: string[] }

export async function readCnabSpreadsheet(file: File): Promise<CnabSpreadsheetResult> {
  const XLSX = await import('xlsx')
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false })
  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, defval: '', raw: false })
    const headerRow = rows.findIndex(row => labels.every(label => row.some(cell => normalize(cell) === label)))
    if (headerRow < 0) continue
    const indexes = new Map(rows[headerRow].map((cell, index) => [normalize(cell), index]))
    const payments: CnabPayment[] = [], errors: string[] = []
    rows.slice(headerRow + 1).forEach((row, offset) => {
      const line = headerRow + offset + 2
      const get = (label: typeof labels[number]) => row[indexes.get(label) ?? -1]
      if (![...labels].some(label => String(get(label)).trim())) return
      const amount = value(get('TOTAL DROP'))
      const paymentDate = date(get('DATA PAGAMENTO'))
      const pix = String(get('PIX') ?? '').trim()
      const document = String(get('CPF CNPJ') ?? '').trim()
      if (!String(get('DROP') ?? '').trim() || !Number.isFinite(amount) || amount <= 0 || !pix || !paymentDate || !document) {
        errors.push(`Linha ${line}: preencha DROP, TOTAL DROP, PIX, DATA PAGAMENTO e CPF/CNPJ.`)
        return
      }
      payments.push({ drop: String(get('DROP')).trim(), responsible: String(get('RESPONSAVEL') ?? '').trim(), value: amount, pix, paymentDate, document, pixHolderName: String(get('RESPONSAVEL') ?? '').trim() })
    })
    return { payments, rowsFound: payments.length + errors.length, errors }
  }
  throw new Error('Não encontrei as colunas obrigatórias: DROP, RESPONSÁVEL, TOTAL DROP, PIX, DATA PAGAMENTO e CPF/CNPJ.')
}
