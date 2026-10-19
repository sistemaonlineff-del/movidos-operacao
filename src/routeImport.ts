export type ImportRoute = { id?: string; street?: string; neighborhood?: string; city?: string; zone?: string; route?: string; postal_code?: string | null; is_active?: boolean; [field: string]: unknown }
const normalized = (value: unknown) => String(value ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ')
export const routeIdentity = (row: ImportRoute) => [row.street, row.neighborhood, row.city, row.zone, row.route].map(normalized).join('|')
const addressIdentity = (row: ImportRoute) => [row.street, row.neighborhood, row.city, row.zone].map(normalized).join('|')
const namedRoute = (value: unknown) => normalized(value) !== 'A DEFINIR' && Boolean(normalized(value))
export function routeImportPlan(existing: ImportRoute[], incoming: ImportRoute[]) {
  const grouped = new Map<string, ImportRoute[]>()
  for (const row of incoming) grouped.set(addressIdentity(row), [...(grouped.get(addressIdentity(row)) ?? []), row])
  const inserts: ImportRoute[] = [], fills: Array<{ id: string; previous: string | null; postal_code: string }> = []
  const updates: Array<{ original: ImportRoute; route: string }> = []
  let skipped = 0
  for (const [identity, rows] of grouped) {
    const codes = [...new Set(rows.map(row => String(row.postal_code ?? '').trim()).filter(Boolean))]
    if (codes.length > 1) throw new Error('A planilha informa CEPs diferentes para o mesmo endereço, zona e rota. Confira antes de importar.')
    const routes = new Map(rows.filter(row => namedRoute(row.route)).map(row => [normalized(row.route), String(row.route).trim()]))
    if (routes.size > 1) throw new Error('A planilha informa rotas diferentes para o mesmo endereço e zona. Confira antes de importar.')
    const matches = existing.filter(row => row.is_active !== false && addressIdentity(row) === identity)
    if (matches.length > 1) throw new Error('Há endereços duplicados na base para esta linha. Confira os registros existentes antes de importar.')
    const current = matches[0], postal_code = codes[0] ?? ''
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