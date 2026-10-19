export type ImportRoute = { id?: string; street?: string; neighborhood?: string; city?: string; zone?: string; route?: string; postal_code?: string | null; is_active?: boolean; [field: string]: unknown }
const normalized = (value: unknown) => String(value ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ')
const addressIdentity = (row: ImportRoute) => [row.street, row.neighborhood, row.city, row.zone].map(normalized).join('|')
const postalIdentity = (value: unknown) => String(value ?? '').replace(/\D/g, '')
export const routeIdentity = (row: ImportRoute) => `${addressIdentity(row)}|${normalized(row.route)}|${postalIdentity(row.postal_code)}`
const namedRoute = (value: unknown) => normalized(value) !== 'A DEFINIR' && Boolean(normalized(value))
export function routeSpreadsheetRows(rows: Record<string, unknown>[]) {
  const header = (value: string) => normalized(value).replace(/[^A-Z0-9]+/g, '')
  const pick = (row: Record<string, unknown>, names: string[]) => {
    for (const name of names) {
      const entry = Object.entries(row).find(([field]) => header(field) === name)
      if (entry && String(entry[1] ?? '').trim()) return String(entry[1]).trim()
    }
    return ''
  }
  return rows.map(row => ({
    street: pick(row, ['RUA', 'LOGRADOURO', 'ENDERECO']), neighborhood: pick(row, ['BAIRRO']), city: pick(row, ['CIDADE', 'MUNICIPIO']),
    postal_code: postalIdentity(pick(row, ['CEP', 'POSTALCODE', 'CODIGOPOSTAL'])).slice(0, 8).replace(/(\d{5})(\d)/, '$1-$2'),
    zone: pick(row, ['ZONA', 'REGIAO', 'ZONE']), route: pick(row, ['ROTA', 'ROUTE', 'MOTORISTA']) || 'A definir',
    delivery_sequence: Number(pick(row, ['SEQUENCIA', 'ORDEM'])) || null,
    latitude: Number(pick(row, ['LATITUDE', 'LAT'])) || null, longitude: Number(pick(row, ['LONGITUDE', 'LNG', 'LON'])) || null, is_active: true,
  }))
}
export function routeImportPlan(existing: ImportRoute[], incoming: ImportRoute[]) {
  const grouped = new Map<string, ImportRoute[]>()
  const incomingByAddress = new Map<string, ImportRoute[]>()
  const existingByAddress = new Map<string, ImportRoute[]>()
  const segmentCounts = new Map<string, number>()
  for (const row of incoming) {
    const identity = addressIdentity(row)
    incomingByAddress.set(identity, [...(incomingByAddress.get(identity) ?? []), row])
  }
  for (const row of existing.filter(entry => entry.is_active !== false)) {
    const identity = addressIdentity(row)
    existingByAddress.set(identity, [...(existingByAddress.get(identity) ?? []), row])
  }
  for (const [identity, peers] of incomingByAddress) {
    const codes = [...new Set(peers.map(other => postalIdentity(other.postal_code)).filter(Boolean))]
    segmentCounts.set(identity, Math.max(1, codes.length))
    for (const row of peers) {
      if (!postalIdentity(row.postal_code) && codes.length > 1) throw new Error('Ha CEP vazio e varios trechos para o mesmo endereco. Informe o CEP de cada linha antes de importar.')
      const code = postalIdentity(row.postal_code) || codes[0] || ''
      const segment = `${identity}|${code}`
      grouped.set(segment, [...(grouped.get(segment) ?? []), { ...row, postal_code: code.replace(/(\d{5})(\d)/, '$1-$2') }])
    }
  }
  const inserts: ImportRoute[] = [], fills: Array<{ id: string; previous: string | null; postal_code: string }> = []
  const updates: Array<{ original: ImportRoute; route: string }> = []
  let skipped = 0
  for (const rows of grouped.values()) {
    const identity = addressIdentity(rows[0])
    const postal_code = String(rows[0].postal_code ?? '')
    const code = postalIdentity(postal_code)
    const routes = new Map(rows.filter(row => namedRoute(row.route)).map(row => [normalized(row.route), String(row.route).trim()]))
    if (routes.size > 1) throw new Error('A planilha informa rotas diferentes para o mesmo endereço e zona. Confira antes de importar.')
    const candidates = existingByAddress.get(identity) ?? []
    let matches = candidates.filter(row => postalIdentity(row.postal_code) === code)
    if (!matches.length && code) {
      const blanks = candidates.filter(row => !postalIdentity(row.postal_code))
      if (blanks.length && (segmentCounts.get(identity) ?? 0) > 1) throw new Error('Ha CEP vazio na base e varios trechos para o mesmo endereco. Confira o cadastro antes de importar.')
      matches = blanks
    }
    if (!code && candidates.length) matches = candidates
    if (matches.length > 1) throw new Error('Há endereços duplicados na base para esta linha. Confira os registros existentes antes de importar.')
    const current = matches[0]
    const route = [...routes.values()][0]
    if (!current) { inserts.push({ ...rows[0], ...(route ? { route } : {}), postal_code }); skipped += rows.length - 1 }
    else {
      let changed = false
      if (!String(current.postal_code ?? '').trim() && postal_code && current.id) {
        fills.push({ id: current.id, previous: current.postal_code ?? null, postal_code }); changed = true
      }
      if (route && normalized(current.route) !== normalized(route)) {
        if (!current.id) throw new Error('Endereço sem identificador. Atualize a base antes de importar.')
        updates.push({ original: current, route }); changed = true
      }
      skipped += rows.length - (changed ? 1 : 0)
    }
  }
  return { inserts, fills, updates, skipped }
}