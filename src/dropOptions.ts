export const DROP_STATUSES = ['INTERESSADO', 'PICKUP - INTERESSADO', 'AG. ASSINATURA', 'CONTRATO ASSINADO', 'ENVIADO - AG. APROVAÇÃO', 'ATIVO', 'ATIVO - AG. LOGIN', 'ATIVO - AG. INSUMOS', 'CONGELADO', 'PROBLEMA', 'EXCLUÍDO']
export const statusTone = (status: string) => status.startsWith('ATIVO') ? 'active' : /PROBLEMA|EXCLU/.test(status) ? 'problem' : status.includes('CONGELADO') ? 'frozen' : 'progress'

export const PARTNERS = ['IMILE DELIVERY BRAZIL LTDA', 'J&T EXPRESS LTDA']
export const ZONES = ['ABC', 'CENTRO', 'FORA DE SP', 'INTERIOR', 'LESTE', 'NORTE', 'OESTE', 'OUTROS ESTADOS', 'SUL']

export const normalizePartner = (value: string | null | undefined) => {
  const raw = (value ?? '').trim()
  if (/^i?mile(?: delivery)?(?: brazil)?(?: ltda)?$/i.test(raw) || /\bimile\b/i.test(raw)) return 'IMILE DELIVERY BRAZIL LTDA'
  if (/^j\s*&\s*t(?: express)?(?: ltda)?$/i.test(raw) || /\bj\s*&\s*t\b/i.test(raw)) return 'J&T EXPRESS LTDA'
  return raw
}

export const normalizeZone = (value: string | null | undefined) => {
  const raw = (value ?? '').trim().toLocaleUpperCase('pt-BR')
  return raw === 'FORA SP' ? 'FORA DE SP' : raw
}
