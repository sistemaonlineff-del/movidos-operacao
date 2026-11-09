export const DROP_REGISTRATION_PATH = '/cadastrar-drop'
export const DROP_REGISTRATION_REVIEW_PATH = '/cadastros/pre-cadastros'
export const DROP_REGISTRATION_API = '/api/drop-registration'
export const DROP_REGISTRATION_BUCKET = 'drop-registration-private'
export const MIN_PHOTOS = 3
export const MAX_PHOTOS = 5
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024
export const MAX_TOTAL_PHOTO_BYTES = 2 * 1024 * 1024
export const MAX_REQUEST_BYTES = 4_500_000
export const REGISTRATION_FIELDS = {
  name: 'Nome do Drop', responsible: 'Responsavel', phone: 'Telefone', alternate_phone: 'Telefone alternativo',
  email: 'E-mail', cpf: 'CPF', cnpj: 'CNPJ', legal_name: 'Razao social', trade_name: 'Nome fantasia',
  state_registration: 'Inscricao estadual', address: 'Endereco', address_number: 'Numero', complement: 'Complemento',
  neighborhood: 'Bairro', municipality: 'Cidade', state: 'UF', postal_code: 'CEP',
  pix_key: 'Chave PIX', pix_holder_name: 'Titular do PIX', company_address: 'Endereco da empresa',
  company_address_number: 'Numero da empresa', company_complement: 'Complemento da empresa',
  company_neighborhood: 'Bairro da empresa', company_municipality: 'Cidade da empresa',
  company_state: 'UF da empresa', company_postal_code: 'CEP da empresa', notes: 'Observacoes'
} as const
export const BRAZIL_STATES = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ')
export type RegistrationField = keyof typeof REGISTRATION_FIELDS
export type RegistrationValues = Record<RegistrationField, string> & { latitude: string; longitude: string }
export type RegistrationSnapshot = Record<RegistrationField, string | null> & { latitude: number; longitude: number }
export type RegistrationPhoto = { content: string; fileName: string; caption: string }
export type RegistrationStoredPhoto = { path: string; hash: string; size: number; type: string; name: string; caption: string }
export type DropRegistration = {
  id: string; status: 'uploading' | 'pending' | 'approved' | 'rejected'; snapshot: RegistrationSnapshot;
  review_snapshot: RegistrationSnapshot | null; photos: RegistrationStoredPhoto[]; revision: number;
  approved_drop_id: string | null; created_at: string; review_note: string | null
}
export const blankRegistration = (): RegistrationValues => Object.fromEntries(
  [...Object.keys(REGISTRATION_FIELDS), 'latitude', 'longitude'].map(field => [field, ''])
) as RegistrationValues
export const registrationValues = (snapshot: RegistrationSnapshot): RegistrationValues => Object.fromEntries(
  Object.entries(snapshot).map(([field, value]) => [field, value == null ? '' : String(value)])
) as RegistrationValues
const clientIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const validClientId = (value: unknown): value is string => typeof value === 'string' && clientIdPattern.test(value)
export const canReviewDropRegistration = (profile: { is_active?: boolean; role?: string } | null, permissions: Record<string, unknown> = {}) =>
  profile?.is_active === true && (profile.role === 'admin' || (permissions.cadastros_create === true && permissions.cadastros_edit === true))

export function validTaxDocument(value: string) {
  if (!/^\d{11}$|^\d{14}$/.test(value) || /^(\d)\1+$/.test(value)) return false
  const weights = value.length === 11 ? [[10,9,8,7,6,5,4,3,2], [11,10,9,8,7,6,5,4,3,2]] : [[5,4,3,2,9,8,7,6,5,4,3,2], [6,5,4,3,2,9,8,7,6,5,4,3,2]]
  return weights.every((sequence, index) => {
    const remainder = sequence.reduce((sum, weight, position) => sum + Number(value[position]) * weight, 0) % 11
    return Number(value[value.length - 2 + index]) === (remainder < 2 ? 0 : 11 - remainder)
  })
}

export function validPixKey(value: string) {
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 77) return true
  if (clientIdPattern.test(value)) return true
  if (!/^[\d\s().+\/-]+$/.test(value)) return false
  const digits = value.replace(/\D/g, '')
  return validTaxDocument(digits) || /^(?:55)?[1-9]{2}\d{8,9}$/.test(digits)
}

export function validateRegistration(input: unknown): RegistrationSnapshot {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Dados do cadastro invalidos.')
  const source = input as Record<string, unknown>
  if (Object.keys(source).some(field => !Object.hasOwn(REGISTRATION_FIELDS, field) && field !== 'latitude' && field !== 'longitude')) throw new Error('Campo nao permitido no cadastro.')
  const snapshot = {} as RegistrationSnapshot
  for (const field of Object.keys(REGISTRATION_FIELDS) as RegistrationField[]) {
    if (source[field] != null && typeof source[field] !== 'string') throw new Error(`${REGISTRATION_FIELDS[field]} invalido.`)
    const value = String(source[field] ?? '').trim()
    if (value.length > (field === 'notes' ? 2000 : 200) || (field === 'notes' ? /[\x00-\x08\x0b\x0c\x0e-\x1f]/ : /[\x00-\x1f\x7f]/).test(value)) throw new Error(`${REGISTRATION_FIELDS[field]} muito longo ou invalido.`)
    snapshot[field] = value || null
  }
  for (const field of ['name','responsible','phone','address','address_number','municipality','state','postal_code'] as RegistrationField[]) {
    if (!snapshot[field]) throw new Error(`Preencha ${REGISTRATION_FIELDS[field]}.`)
  }
  for (const field of ['phone','alternate_phone','cpf','cnpj','postal_code','company_postal_code'] as const) {
    if (!snapshot[field]) continue
    if (!/^[\d\s().+\/-]+$/.test(snapshot[field])) throw new Error(`${REGISTRATION_FIELDS[field]} invalido.`)
    snapshot[field] = snapshot[field].replace(/\D/g, '')
  }
  if (!/^\d{10,13}$/.test(snapshot.phone!) || (snapshot.alternate_phone && !/^\d{10,13}$/.test(snapshot.alternate_phone))) throw new Error('Telefone invalido; informe DDD e numero.')
  for (const field of ['cpf','cnpj'] as const) if (snapshot[field] && (snapshot[field].length !== (field === 'cpf' ? 11 : 14) || !validTaxDocument(snapshot[field]))) throw new Error(`${field.toUpperCase()} invalido.`)
  for (const field of ['postal_code','company_postal_code'] as const) if (snapshot[field] && !/^\d{8}$/.test(snapshot[field])) throw new Error('CEP deve ter 8 digitos.')
  for (const field of ['state','company_state'] as const) {
    if (snapshot[field]) snapshot[field] = snapshot[field].toUpperCase()
    if (snapshot[field] && !BRAZIL_STATES.includes(snapshot[field])) throw new Error('Selecione uma UF brasileira valida.')
  }
  if (snapshot.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(snapshot.email)) throw new Error('E-mail invalido.')
  if (snapshot.pix_key && !validPixKey(snapshot.pix_key)) throw new Error('Chave PIX invalida; informe CPF, CNPJ, telefone, e-mail ou chave aleatoria.')
  for (const field of ['latitude','longitude'] as const) {
    const value = source[field]
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') throw new Error('Informe latitude e longitude do local.')
    snapshot[field] = Number(value)
  }
  if (!Number.isFinite(snapshot.latitude) || !Number.isFinite(snapshot.longitude) || snapshot.latitude < -35 || snapshot.latitude > 6 || snapshot.longitude < -75 || snapshot.longitude > -32) throw new Error('Coordenadas fora dos limites brasileiros aceitos pelo mapa.')
  return snapshot
}