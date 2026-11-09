import Papa from 'papaparse'

export type MaisEnviosValidity = 'valid' | 'invalid' | 'pending' | 'duplicate'
export type MaisEnviosClosingRow = {
  id: string; kind: 'marketplace' | 'posting'; period: string; values: string[];
  originalCode: string; code: string; smart: string; createdAt: string;
  valueCents: number; validity: MaisEnviosValidity; manual: 'valid' | 'invalid' | null;
}
export type MaisEnviosClosingContact = { smart: string; email: string; responsible: string; registrationId: string | null }
export type MaisEnviosClosing = { id: string; period: string; rows: MaisEnviosClosingRow[]; contacts: MaisEnviosClosingContact[]; subject: string; body: string }
export const maisEnviosSmartKey = (name: string) => name.trim().toLocaleLowerCase('pt-BR')
const headerKey = (value: string) => value.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

export function maisEnviosCents(value: string): number {
  const raw = value.trim().replace(/^R\$\s*/, '').replace(/\s/g, '')
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error('Valor de postagem invalido: confira o CSV.')
  const negative = normalized.startsWith('-')
  const [whole, fraction = ''] = normalized.replace(/^-/, '').split('.')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents) || cents > 1e12) throw new Error('Valor fora do limite do fechamento.')
  return negative ? -cents : cents
}

export function maisEnviosDate(value: string): number {
  const raw = value.trim()
  const match = /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw)
  const iso = match ? `${match[3]}-${match[2]}-${match[1]}T${match[4] ?? '00'}:${match[5] ?? '00'}:${match[6] ?? '00'}Z` : raw
  if (!/^\d{4}-\d{2}-\d{2}(?:$|T| )/.test(iso)) return 0
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number)
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return 0
  const result = Date.parse(iso)
  return Number.isFinite(result) && result > 0 ? result : 0
}

export function extractMaisEnviosCode(original: string): string {
  const found = [...new Set(original.toUpperCase().replace(/[\r\n]/g, '').match(/[A-Z]{2}[0-9]{9}BR/g) ?? [])]
  return found.length === 1 ? found[0] : original.trim()
}

export function maisEnviosCodeValidity(original: string): MaisEnviosValidity {
  const code = extractMaisEnviosCode(original)
  if (/^(?:[A-Z]{2}[0-9]{9}BR|[0-9]{10,11})$/i.test(code)) return 'valid'
  if (/^(?:[0-9]{5}-[0-9]{3}|[0-9]{8}|BR[0-9]{13}|BR[0-9]{12}[A-Z])$/i.test(code)) return 'invalid'
  return 'pending'
}

export function maisEnviosPostingValidity(status: string): MaisEnviosValidity {
  const normalized = status.trim().toLowerCase()
  if (normalized === 'entregue') return 'valid'
  if (normalized === 'etiqueta expirada') return 'invalid'
  return 'pending'
}

export function validateMaisEnviosRows(rows: MaisEnviosClosingRow[], history: MaisEnviosClosingRow[] = []): MaisEnviosClosingRow[] {
  const existing = new Set(history.filter(row => row.kind === 'marketplace').map(row => extractMaisEnviosCode(row.code).toUpperCase()))
  const normalized = rows.map(row => ({ ...row, code: row.kind === 'marketplace' ? extractMaisEnviosCode(row.code) : row.code.trim() }))
  const principal = new Map<string, number>()
  normalized.forEach((row, index) => {
    if (row.kind !== 'marketplace' || !row.code) return
    const key = row.code.toUpperCase(), previous = principal.get(key)
    const date = maisEnviosDate(row.createdAt), oldDate = previous === undefined ? 0 : maisEnviosDate(normalized[previous].createdAt)
    if (previous === undefined || (date > 0 && (!oldDate || date < oldDate)) || date === oldDate) principal.set(key, index)
  })
  return normalized.map((row, index) => {
    if (!row.code) return { ...row, validity: 'pending' }
    if (row.kind === 'marketplace' && (existing.has(row.code.toUpperCase()) || principal.get(row.code.toUpperCase()) !== index)) return { ...row, validity: 'duplicate' }
    const automatic = row.kind === 'marketplace' ? maisEnviosCodeValidity(row.code) : maisEnviosPostingValidity(row.values[1] ?? '')
    return { ...row, validity: automatic === 'pending' ? row.manual ?? 'pending' : automatic }
  })
}

export function importMaisEnviosCsv(text: string, period: string, history: MaisEnviosClosingRow[], postingSmart = '') {
  if (!period.trim() || period.trim().length > 100) throw new Error('Informe um periodo de ate 100 caracteres.')
  const parsed = Papa.parse<string[]>(text.replace(/^\uFEFF/, ''), { delimiter: ';', skipEmptyLines: 'greedy' })
  if (parsed.errors.length) throw new Error('CSV malformado. Exporte novamente com separador ponto e virgula.')
  const header = parsed.data.slice(0, 5).findIndex(row => (headerKey(row[0] ?? '') === 'id' && headerKey(row[5] ?? '') === 'codigo de rastreio') || (headerKey(row[0] ?? '') === 'etiqueta' && headerKey(row[1] ?? '') === 'status'))
  if (header < 0) throw new Error('CSV nao reconhecido: esperado Marketplace ou Postagem, com cabecalho nas primeiras cinco linhas.')
  const kind = headerKey(parsed.data[header][0]) === 'id' ? 'marketplace' : 'posting'
  const labels = new Set(history.filter(row => row.kind === 'posting').map(row => row.code.toUpperCase()))
  const records = parsed.data.slice(header + 1)
  const lastPosting = new Map<string, number>()
  if (kind === 'posting') records.forEach((record, index) => lastPosting.set((record[0] ?? '').trim().toUpperCase(), index))
  const rows: MaisEnviosClosingRow[] = []
  let skipped = 0
  for (const [index, original] of records.entries()) {
    const values = original.map(value => value.trim())
    if (values.some(value => value.length > 2000)) throw new Error('Campo do CSV excede 2.000 caracteres.')
    const code = values[kind === 'marketplace' ? 5 : 0] ?? ''
    if (!code) continue
    if (kind === 'posting' && (labels.has(code.toUpperCase()) || lastPosting.get(code.toUpperCase()) !== index)) { skipped++; continue }
    if (values.length < (kind === 'marketplace' ? 8 : 9)) throw new Error('Linha incompleta no CSV. Confira as colunas antes de importar.')
    if (kind === 'posting') labels.add(code.toUpperCase())
    rows.push({ id: crypto.randomUUID(), kind, period: period.trim(), values: values.slice(0, kind === 'marketplace' ? 8 : 9), originalCode: code, code,
      smart: kind === 'marketplace' ? values[4] : postingSmart.trim(), createdAt: values[kind === 'marketplace' ? 7 : 4],
      valueCents: kind === 'posting' ? maisEnviosCents(values[8]) : 0, validity: 'pending', manual: null })
    if (rows.length > 20000) throw new Error('Limite de 20.000 linhas por fechamento.')
  }
  return { rows, skipped, kind }
}

export function maisEnviosSummaries(rows: MaisEnviosClosingRow[], period: string) {
  const groups = new Map<string, { smart: string; packages: number; postingCents: number }>()
  for (const row of rows) {
    if (maisEnviosSmartKey(row.period) !== maisEnviosSmartKey(period) || !row.smart.trim()) continue
    const key = maisEnviosSmartKey(row.smart)
    const group = groups.get(key) ?? { smart: row.smart.trim(), packages: 0, postingCents: 0 }
    if (row.validity === 'valid') {
      if (row.kind === 'marketplace') group.packages++
      else group.postingCents += row.valueCents
    }
    if (!Number.isSafeInteger(group.postingCents) || Math.abs(group.postingCents) > 1e12) throw new Error('Total fora do limite financeiro.')
    groups.set(key, group)
  }
  const rounded = (numerator: bigint) => Number((numerator < 0n ? -1n : 1n) * ((numerator < 0n ? -numerator : numerator) + 50n) / 100n)
  return [...groups.values()].map(group => {
    const marketplaceCents = group.packages * 50
    const net = BigInt(group.postingCents) * 85n - BigInt(marketplaceCents) * 100n
    return { ...group, marketplaceCents, smartShareCents: rounded(BigInt(group.postingCents) * 15n), companyShareCents: rounded(BigInt(group.postingCents) * 85n),
      resultCents: Math.abs(rounded(net)), direction: net > 0n ? 'Smart paga para +Envios' : net < 0n ? '+Envios paga para Smart' : 'Quitado' }
  }).sort((left, right) => left.smart.localeCompare(right.smart, 'pt-BR'))
}

export function assertMaisEnviosClosing(closing: MaisEnviosClosing) {
  if (!closing.period.trim() || closing.period.length > 100 || !closing.rows.length || closing.rows.length > 20000) throw new Error('Confira o periodo e as linhas do fechamento.')
  if (!closing.subject.trim() || closing.subject.length > 200 || /[\r\n]/.test(closing.subject) || !closing.body.trim() || closing.body.length > 30000) throw new Error('Confira o assunto e o texto do e-mail.')
  if (closing.rows.some(row => row.period !== closing.period || row.validity === 'pending' || !row.code.trim() || !row.smart.trim() || row.smart.length > 200)) throw new Error('Resolva todas as validacoes pendentes e informe a Smart de cada linha.')
  for (const row of closing.rows) {
    const automatic = row.kind === 'marketplace' ? maisEnviosCodeValidity(row.code) : maisEnviosPostingValidity(row.values[1] ?? '')
    if (row.validity !== 'duplicate' && row.validity !== (automatic === 'pending' ? row.manual ?? 'pending' : automatic)) throw new Error('A validacao nao corresponde ao codigo ou status salvo.')
    if (row.valueCents !== (row.kind === 'posting' ? maisEnviosCents(row.values[8]) : 0)) throw new Error('Valor de postagem diferente da linha original.')
  }
  if (new Set(closing.rows.map(row => row.id)).size !== closing.rows.length) throw new Error('Identificadores de linha repetidos.')
  for (const summary of maisEnviosSummaries(closing.rows, closing.period)) {
    const contacts = closing.contacts.filter(contact => maisEnviosSmartKey(contact.smart) === maisEnviosSmartKey(summary.smart))
    if (contacts.length !== 1) throw new Error('Confira o contato de cada Smart antes de salvar o snapshot.')
    if (contacts[0].email && !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(contacts[0].email)) throw new Error('E-mail da Smart invalido.')
  }
  if (new TextEncoder().encode(JSON.stringify(closing)).length > 3000000) throw new Error('Fechamento maior que 3 MB. Divida os arquivos antes de importar.')
}