export const MAIS_ENVIOS_STAGES = [
  'Dados enviados para gerar contrato',
  'Contrato gerado aguardando assinatura',
  'Contrato assinado aguardando criacao smart e login/senha',
  'Smart criada aguardando kit',
  'Kit enviado aguardando contato AGF',
  'Smart ativa coleta agendada',
] as const

export const MAIS_ENVIOS_FIELDS = [
  'cnpj', 'smart', 'responsavel', 'telefone', 'email', 'endereco', 'numero',
  'complemento', 'bairro', 'cidade', 'uf', 'cep', 'tamanho_camiseta',
] as const

export type MaisEnviosField = typeof MAIS_ENVIOS_FIELDS[number]
export type MaisEnviosValues = Record<MaisEnviosField, string> & { etapa: number }
export type MaisEnviosRow = MaisEnviosValues & {
  id: string; created_at: string; updated_at: string; created_by: string | null
}

export function emptyMaisEnvios(): MaisEnviosValues {
  return { etapa: 1, cnpj: '', smart: '', responsavel: '', telefone: '', email: '',
    endereco: '', numero: '', complemento: '', bairro: '', cidade: '', uf: '', cep: '', tamanho_camiseta: '' }
}

export function maisEnviosPayload(values: MaisEnviosValues): MaisEnviosValues {
  const payload = emptyMaisEnvios()
  for (const field of MAIS_ENVIOS_FIELDS) payload[field] = String(values[field] ?? '').trim()
  payload.etapa = Number(values.etapa)
  payload.cnpj = payload.cnpj.replace(/\D/g, '')
  payload.cep = payload.cep.replace(/\D/g, '')
  payload.uf = payload.uf.toUpperCase()
  if (!Number.isInteger(payload.etapa) || payload.etapa < 1 || payload.etapa > 6) throw new Error('Selecione uma etapa valida.')
  if (!payload.smart) throw new Error('Informe o nome da smart.')
  if (MAIS_ENVIOS_FIELDS.some(field => payload[field].length > 300)) throw new Error('Os campos devem ter no maximo 300 caracteres.')
  if (payload.cnpj && !/^\d{14}$/.test(payload.cnpj)) throw new Error('Informe um CNPJ com 14 digitos.')
  if (payload.cep && !/^\d{8}$/.test(payload.cep)) throw new Error('Informe um CEP com 8 digitos.')
  if (payload.uf && !/^[A-Z]{2}$/.test(payload.uf)) throw new Error('Informe a UF com duas letras.')
  if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) throw new Error('Informe um email valido.')
  return payload
}

export function maisEnviosSearch(search: string): string {
  const text = search.trim().slice(0, 100)
  if (!text) return ''
  const literal = text.replace(/[\\%_*]/g, '\\$&').replace(/"/g, '\\"')
  const filters = MAIS_ENVIOS_FIELDS.map(field => `${field}.ilike."%${literal}%"`)
  const digits = text.replace(/\D/g, '')
  if (digits && digits !== text && /^[\d\s()./+-]+$/.test(text)) {
    for (const field of ['cnpj', 'cep']) filters.push(`${field}.ilike."%${digits}%"`)
  }
  return filters.join(',')
}

export function maisEnviosError(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : 'Nao foi possivel concluir a operacao.'
}