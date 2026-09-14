import type { DataRow } from './financialData'

export type CnabPayment = {
  drop: string
  responsible: string
  value: number
  pix: string
  pixHolderName: string
  paymentDate: string
  document: string
}

export const CNAB_INTER_FILE_NAME = 'CI240_001_0000001.REM'

const COMPANY = {
  bank: '077',
  branch: '00001',
  branchDigit: '9',
  account: '53904036',
  accountDigit: '3',
  name: 'MOVIDOS MODA FASHION LTDA',
  document: '55440354000149',
  street: 'RUA GATO CINZENTO',
  number: '393',
  complement: '',
  city: 'SUZANO',
  state: 'SP',
  postalCode: '08615070',
} as const

const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '')
const textField = (value: unknown, size: number) => String(value ?? '').trim().toUpperCase().slice(0, size).padEnd(size, ' ')
const numberField = (value: unknown, size: number) => String(value ?? '').trim().padStart(size, '0').slice(-size)
const valueField = (value: number, size: number) => numberField(Math.round(value * 100), size)

function dateField(value: string | Date) {
  const date = value instanceof Date ? value : /^\d{4}-\d{2}-\d{2}/.test(value)
    ? new Date(`${value.slice(0, 10)}T12:00:00`)
    : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('Há pagamento sem uma data válida.')
  return `${String(date.getDate()).padStart(2, '0')}${String(date.getMonth() + 1).padStart(2, '0')}${date.getFullYear()}`
}

function timeField(date: Date) {
  return `${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`
}

function record(fields: Array<[start: number, size: number, value: string]>) {
  const result = Array<string>(240).fill(' ')
  for (const [start, size, value] of fields) {
    if (start + size - 1 > 240) throw new Error('Campo ultrapassa 240 posições.')
    value.slice(0, size).split('').forEach((character, index) => { result[start - 1 + index] = character })
  }
  return result.join('')
}

export function pixKeyType(value: unknown) {
  const source = String(value ?? '').trim().toUpperCase()
  const numeric = digits(source)
  if (source.includes('@')) return '02'
  if ([11, 14].includes(numeric.length) && (numeric === source || source.replace(/[.\/-]/g, '') === numeric)) return '03'
  if (numeric.startsWith('55') && [12, 13].includes(numeric.length)) return '01'
  if ([10, 11].includes(numeric.length)) return '01'
  return '04'
}

export function prepareCnabPayments(rows: DataRow[]): CnabPayment[] {
  const grouped = new Map<string, CnabPayment>()
  for (const row of rows) {
    const identity = `${String(row.period ?? '').trim()}|${String(row.partner ?? '').trim()}|${String(row.drop ?? '').trim().toUpperCase()}`
    const current = grouped.get(identity)
    const value = Number(row.receivable)
    if (!Number.isFinite(value)) throw new Error(`O total a receber de ${row.drop || 'um DROP'} é inválido.`)
    if (current) {
      current.value = Math.round((current.value + value + Number.EPSILON) * 100) / 100
      current.responsible ||= String(row.responsible ?? '').trim()
      current.pix ||= String(row.pix ?? '').trim()
      current.pixHolderName ||= String(row.pixHolderName ?? '').trim()
      current.paymentDate ||= String(row.paymentDate ?? '').trim()
      current.document ||= digits(row.document)
    } else {
      grouped.set(identity, {
        drop: String(row.drop ?? '').trim(),
        responsible: String(row.responsible ?? '').trim(),
        value,
        pix: String(row.pix ?? '').trim(),
        pixHolderName: String(row.pixHolderName ?? '').trim(),
        paymentDate: String(row.paymentDate ?? '').trim(),
        document: digits(row.document),
      })
    }
  }
  return [...grouped.values()]
}

export function createCnabInter(payments: CnabPayment[], generatedAt = new Date()) {
  if (!payments.length) throw new Error('Nenhum pagamento encontrado para gerar o CNAB.')
  const invalidDate = payments.find(payment => !payment.paymentDate)
  if (invalidDate) throw new Error(`Informe a data de pagamento do DROP ${invalidDate.drop}.`)
  const lines: string[] = []
  lines.push(record([
    [1, 3, COMPANY.bank], [4, 4, '0000'], [8, 1, '0'], [18, 1, '2'], [19, 14, COMPANY.document],
    [53, 5, COMPANY.branch], [58, 1, COMPANY.branchDigit], [59, 12, numberField(COMPANY.account, 12)], [71, 1, COMPANY.accountDigit],
    [73, 30, textField(COMPANY.name, 30)], [103, 30, textField('BANCO INTER', 30)], [143, 1, '1'],
    [144, 8, dateField(generatedAt)], [152, 6, timeField(generatedAt)], [158, 6, numberField(1, 6)], [164, 3, '107'], [167, 5, '01600'],
  ]))
  lines.push(record([
    [1, 3, COMPANY.bank], [4, 4, '0001'], [8, 1, '1'], [9, 1, 'C'], [10, 2, '20'], [12, 2, '45'], [14, 3, '046'],
    [18, 1, '2'], [19, 14, COMPANY.document], [53, 5, COMPANY.branch], [58, 1, COMPANY.branchDigit],
    [59, 12, numberField(COMPANY.account, 12)], [71, 1, COMPANY.accountDigit], [73, 30, textField(COMPANY.name, 30)],
    [143, 30, textField(COMPANY.street, 30)], [173, 5, numberField(COMPANY.number, 5)], [178, 15, textField(COMPANY.complement, 15)],
    [193, 20, textField(COMPANY.city, 20)], [213, 5, COMPANY.postalCode.slice(0, 5)], [218, 3, COMPANY.postalCode.slice(-3)], [221, 2, COMPANY.state],
  ]))
  let sequence = 1
  for (const payment of payments) {
    lines.push(record([
      [1, 3, COMPANY.bank], [4, 4, '0001'], [8, 1, '3'], [9, 5, numberField(sequence, 5)], [14, 1, 'A'],
      [15, 1, '0'], [16, 2, '00'], [18, 3, '000'], [21, 3, '000'], [24, 5, '00000'], [29, 1, '0'],
      [30, 12, '000000000000'], [42, 1, '0'], [44, 30, '000000000000000000000000000000'],
      [94, 8, dateField(payment.paymentDate)], [102, 3, 'BRL'], [105, 15, '000000000000000'], [120, 15, valueField(payment.value, 15)],
    ]))
    sequence += 1
    const type = pixKeyType(payment.pix)
    const document = digits(payment.document)
    lines.push(record([
      [1, 3, COMPANY.bank], [4, 4, '0001'], [8, 1, '3'], [9, 5, numberField(sequence, 5)], [14, 1, 'B'],
      [15, 3, type], [18, 1, document.length === 11 ? '1' : '2'], [19, 14, numberField(document, 14)],
      [128, 99, textField(type === '03' ? digits(payment.pix) : payment.pix, 99)], [233, 8, '00000000'],
    ]))
    sequence += 1
  }
  const total = payments.reduce((sum, payment) => sum + payment.value, 0)
  lines.push(record([
    [1, 3, COMPANY.bank], [4, 4, '0001'], [8, 1, '5'], [18, 6, numberField(2 + payments.length * 2 + 1, 6)],
    [24, 6, numberField(payments.length, 6)], [30, 18, valueField(total, 18)],
  ]))
  lines.push(record([
    [1, 3, COMPANY.bank], [4, 4, '9999'], [8, 1, '9'], [18, 6, '000001'], [24, 6, numberField(2 + payments.length * 2 + 2, 6)],
  ]))
  return `${lines.join('\r\n')}\r\n`
}

export function downloadCnabInter(rows: DataRow[]) {
  const payments = prepareCnabPayments(rows)
  return downloadCnabPayments(payments)
}

export function downloadCnabPayments(payments: CnabPayment[]) {
  const content = createCnabInter(payments)
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=us-ascii' }))
  const link = document.createElement('a')
  link.href = url
  link.download = CNAB_INTER_FILE_NAME
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return payments.length
}
