export type ImportRoute = { id?: string; street?: string; neighborhood?: string; city?: string; zone?: string; route?: string; postal_code?: string | null; is_active?: boolean; [field: string]: unknown }
const normalized = (value: unknown) => String(value ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ')
export const routeIdentity = (row: ImportRoute) => [row.street, row.neighborhood, row.city, row.zone, row.route].map(normalized).join('|')
export function routeImportPlan(existing: ImportRoute[], incoming: ImportRoute[]) {
  const grouped = new Map<string, ImportRoute[]>()
  for (const row of incoming) grouped.set(routeIdentity(row), [...(grouped.get(routeIdentity(row)) ?? []), row])
  const inserts: ImportRoute[] = [], fills: Array<{ id: string; previous: string | null; postal_code: string }> = []
  let skipped = 0
  for (const [identity, rows] of grouped) {
    const codes = [...new Set(rows.map(row => String(row.postal_code ?? '').trim()).filter(Boolean))]
    if (codes.length > 1) throw new Error('A planilha informa CEPs diferentes para o mesmo endereço, zona e rota. Confira antes de importar.')
    const matches = existing.filter(row => row.is_active !== false && routeIdentity(row) === identity)
    if (matches.length > 1) throw new Error('Há endereços duplicados na base para esta linha. Confira os registros existentes antes de importar.')
    const current = matches[0], postal_code = codes[0] ?? ''
    if (!current) { inserts.push({ ...rows[0], postal_code }); skipped += rows.length - 1 }
    else if (!String(current.postal_code ?? '').trim() && postal_code && current.id) {
      fills.push({ id: current.id, previous: current.postal_code ?? null, postal_code }); skipped += rows.length - 1
    } else { skipped += rows.length }
  }
  return { inserts, fills, skipped }
}