export const addressFields = ['street', 'number', 'complement', 'neighborhood', 'city', 'postalCode'] as const
export type LabelAddress = Record<typeof addressFields[number], string | null>
export interface LabelExtraction { recipient: LabelAddress; warnings: string[]; uncertainFields: string[] }
export const addressLabels: Record<keyof LabelAddress, string> = {
  street: 'Rua / Logradouro', neighborhood: 'Bairro', city: 'Cidade', postalCode: 'CEP',
  number: 'Numero', complement: 'Complemento',
}

export function parseLabelExtraction(value: unknown): LabelExtraction {
  if (!value || typeof value !== 'object') throw new Error('Resposta inválida da leitura.')
  const data = value as Record<string, unknown>
  const source = data.recipient
  if (!source || typeof source !== 'object') throw new Error('Endereço inválido da leitura.')
  const recipient = Object.fromEntries(addressFields.map(field => {
    const raw = (source as Record<string, unknown>)[field]
    const entry = raw === undefined && (field === 'number' || field === 'complement') ? null : raw
    if (entry !== null && (typeof entry !== 'string' || entry.length > 500)) throw new Error('Campo inválido da leitura.')
    return [field, typeof entry === 'string' ? entry.trim() || null : null]
  })) as LabelAddress
  const strings = (name: string): string[] => {
    const entries = data[name]
    if (!Array.isArray(entries) || entries.length > 50 || entries.some(entry => typeof entry !== 'string' || entry.length > 1000)) throw new Error('Lista inválida da leitura.')
    return entries
  }
  const result = { recipient, warnings: strings('warnings'), uncertainFields: strings('uncertainFields') }
  if (recipient.postalCode) {
    const digits = recipient.postalCode.replace(/[\s.-]/g, '')
    if (/^\d{8}$/.test(digits)) recipient.postalCode = `${digits.slice(0, 5)}-${digits.slice(5)}`
    else { recipient.postalCode = null; result.warnings.push('CEP ilegível ou incompleto: confira a foto.'); result.uncertainFields.push('recipient.postalCode') }
  }
  return result
}

export function extractionQuery(data: LabelExtraction): string {
  const field = (name: keyof LabelAddress) => data.uncertainFields.includes(`recipient.${name}`) ? '' : data.recipient[name] || ''
  return [field('street'), field('neighborhood'), field('city'), field('postalCode')].filter(Boolean).join('\n')
}

export function labelDeliveryAddress(data: LabelExtraction) {
  const packageAddress = addressFields.filter(field => !data.uncertainFields.includes(`recipient.${field}`)).map(field => data.recipient[field]).filter(Boolean).join(', ')
  return { packageAddress, addressConfirmed: !data.uncertainFields.length && !data.warnings.length && ['street','number','city','postalCode'].every(field => Boolean(data.recipient[field as keyof LabelAddress])) }
}
