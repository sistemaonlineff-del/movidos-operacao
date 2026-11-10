export type DispatchDriver = { id: string; name: string }
export type DispatchVolume = { id: string; driver_id: string | null; driver_name: string | null; recipient_address: string | null; address_confirmed: boolean; delivery_sequence: number | null; created_at: string; street: string | null; neighborhood: string | null; city: string | null; postal_code: string | null }
export const brazilDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
export const dispatchAddress = (row: DispatchVolume) => row.recipient_address || [row.street, row.neighborhood, row.city, row.postal_code].filter(Boolean).join(', ')
export function orderedDispatch(rows: DispatchVolume[]): DispatchVolume[] {
  return [...rows].sort((first, second) => (first.delivery_sequence ?? Number.MAX_SAFE_INTEGER) - (second.delivery_sequence ?? Number.MAX_SAFE_INTEGER) || first.created_at.localeCompare(second.created_at) || first.id.localeCompare(second.id))
}
export function dispatchMapsLinks(rows: DispatchVolume[], origin = '') {
  if (!rows.length || rows.some(row => !row.address_confirmed || !row.recipient_address?.trim())) throw new Error('Confira o endereco completo de todas as paradas antes de exportar.')
  const links: string[] = []
  let previous = origin.trim()
  for (let offset = 0; offset < rows.length; offset += 4) {
    const addresses = rows.slice(offset, offset + 4).map(row => row.recipient_address!)
    const query = new URLSearchParams({ api: '1', travelmode: 'driving', destination: addresses[addresses.length - 1] })
    if (previous) query.set('origin', previous)
    if (addresses.length > 1) query.set('waypoints', addresses.slice(0, -1).join('|'))
    const link = `https://www.google.com/maps/dir/?${query}`
    if (link.length > 2048) throw new Error('Endereco muito longo para o Maps. Exporte o Excel ou reduza o texto do endereco.')
    links.push(link); previous = addresses[addresses.length - 1]
  }
  return links
}