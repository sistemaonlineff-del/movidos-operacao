import { mapsAddressText } from './labelExtraction'

export type DispatchDriver = { id: string; name: string }
export type DispatchVolume = { id: string; driver_id: string | null; driver_name: string | null; capture_number?: number | null; maps_address?: string | null; recipient_address: string | null; address_confirmed: boolean; delivery_sequence: number | null; created_at: string; street: string | null; neighborhood: string | null; city: string | null; postal_code: string | null }
export const brazilDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
export const dispatchAddress = (row: DispatchVolume) => row.recipient_address || [row.street, row.neighborhood, row.city, row.postal_code].filter(Boolean).join(', ')
export const dispatchMapsAddress = (row: DispatchVolume) => row.maps_address?.trim() || mapsAddressText(dispatchAddress(row))
export function dispatchSpreadsheetRows(rows: DispatchVolume[], day: string) {
  return [['Motorista','Dia','Ordem','Numero da foto','Endereco','Conferido','Sequencia da base','Leitura'], ...rows.map((row,index) => [row.driver_name,day,index+1,row.capture_number ?? '',dispatchAddress(row),row.address_confirmed?'Sim':'Pendente',row.delivery_sequence,row.id])]
}
export function orderedDispatch(rows: DispatchVolume[]): DispatchVolume[] {
  return [...rows].sort((first, second) => (first.delivery_sequence ?? Number.MAX_SAFE_INTEGER) - (second.delivery_sequence ?? Number.MAX_SAFE_INTEGER) || first.created_at.localeCompare(second.created_at) || first.id.localeCompare(second.id))
}
export function dispatchMapsLinks(rows: DispatchVolume[], origin = '', stopsPerLink = 4) {
  if (!rows.length || rows.some(row => !row.address_confirmed || !row.recipient_address?.trim())) throw new Error('Confira o endereco completo de todas as paradas antes de exportar.')
  if (![4, 10].includes(stopsPerLink)) throw new Error('Escolha ate 4 ou ate 10 paradas por trecho.')
  const destinations = rows.map(dispatchMapsAddress)
  const links: string[] = []
  let previous = mapsAddressText(origin.trim())
  for (let offset = 0; offset < destinations.length;) {
    let end = Math.min(offset + stopsPerLink, destinations.length)
    let link = ''
    while (end > offset) {
      const addresses = destinations.slice(offset, end)
      const query = new URLSearchParams({ api: '1', travelmode: 'driving', dir_action: 'navigate', destination: addresses[addresses.length - 1] })
      if (previous) query.set('origin', previous)
      if (addresses.length > 1) query.set('waypoints', addresses.slice(0, -1).join('|'))
      link = `https://www.google.com/maps/dir/?${query}`
      if (link.length <= 2048) break
      end--
    }
    if (end === offset) throw new Error('Endereco muito longo para o Maps. Exporte o Excel ou reduza o texto do endereco.')
    links.push(link); previous = destinations[end - 1]; offset = end
  }
  return links
}