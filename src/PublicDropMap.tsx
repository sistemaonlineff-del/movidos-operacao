import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import { MapPin, Search, RotateCcw, Navigation, RefreshCw } from 'lucide-react'
import 'leaflet/dist/leaflet.css'
import { supabase } from './lib/supabase'
import { useDropRegistrationViewport } from './dropRegistrationClient'
import './public-drop-map.css'

type Point = { id: string; name: string | null; address: string | null; address_number: string | null; neighborhood: string | null; municipality: string | null; state: string | null; postal_code: string | null; latitude: number; longitude: number }
const normalized = (value: string | null) => (value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR')
const addressOf = (point: Point) => [point.address, point.address_number, point.neighborhood, point.municipality, point.state, point.postal_code].filter(Boolean).join(', ')

export default function PublicDropMap() {
  const [points, setPoints] = useState<Point[]>([]), [search, setSearch] = useState(''), [city, setCity] = useState(''), [neighborhood, setNeighborhood] = useState('')
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [version, setVersion] = useState(0)
  const holder = useRef<HTMLDivElement>(null), map = useRef<L.Map | null>(null)
  useDropRegistrationViewport()
  useEffect(() => {
    let active = true
    setLoading(true); setError(''); setPoints([])
    void (async () => {
      try {
        if (!supabase) throw new Error('Mapa indisponivel.')
        const all: Point[] = []
        for (let offset = 0; ; offset += 200) {
          const result = await supabase.rpc('public_active_drops').range(offset, offset + 199)
          if (result.error) throw new Error('Nao foi possivel carregar os pontos. Tente novamente.')
          if (!active) return
          const batch = result.data as Point[]
          all.push(...batch)
          if (batch.length < 200) break
        }
        if (active) setPoints(all)
      } catch (failure) { if (active) setError(failure instanceof Error ? failure.message : 'Mapa indisponivel.') }
      finally { if (active) setLoading(false) }
    })()
    return () => { active = false }
  }, [version])
  const cities = [...new Set(points.map(point => point.municipality).filter((value): value is string => Boolean(value)))].sort((first, second) => first.localeCompare(second, 'pt-BR'))
  const neighborhoods = [...new Set(points.filter(point => !city || point.municipality === city).map(point => point.neighborhood).filter((value): value is string => Boolean(value)))].sort((first, second) => first.localeCompare(second, 'pt-BR'))
  const filtered = points.filter(point => (!city || point.municipality === city) && (!neighborhood || point.neighborhood === neighborhood) && normalized(search).trim().split(/\s+/).every(term => normalized(`${point.name} ${addressOf(point)}`).includes(term)))
  const pointKey = filtered.map(point => `${point.id}:${point.latitude}:${point.longitude}`).join('|')
  useEffect(() => {
    if (!holder.current) return
    const instance = L.map(holder.current).setView([-14.235, -51.925], 4)
    map.current = instance
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap', maxZoom: 19 }).addTo(instance)
    return () => { map.current = null; instance.remove() }
  }, [])
  useEffect(() => {
    if (!map.current) return
    const layer = L.layerGroup().addTo(map.current), bounds: L.LatLngTuple[] = []
    for (const point of filtered) {
      const location: [number, number] = [Number(point.latitude), Number(point.longitude)], popup = document.createElement('div')
      for (const text of [point.name ?? 'Drop', addressOf(point)]) { const line = document.createElement('div'); line.textContent = text; popup.append(line) }
      L.circleMarker(location, { radius: 8, color: '#155e48', fillColor: '#24a276', fillOpacity: 0.9, weight: 2 }).bindPopup(popup).addTo(layer)
      bounds.push(location)
    }
    if (bounds.length) map.current.fitBounds(bounds, { padding: [30, 30], maxZoom: 15, animate: false })
    return () => { layer.remove() }
  }, [pointKey, points])
  return <main className="public-drop-map">
    <header><img src="/brand/movidos-wordmark.png" alt="Movidos"/><h1>Pontos de coleta</h1><span>Somente Drops ativos</span></header>
    <form className="pdm-filters" onSubmit={event => event.preventDefault()}>
      <label><span><Search size={16}/> Buscar endereco ou Drop</span><input type="search" value={search} onChange={event => setSearch(event.target.value)}/></label>
      <label>Cidade<select aria-label="Cidade" value={city} onChange={event => { setCity(event.target.value); setNeighborhood('') }}><option value="">Todas as cidades</option>{cities.map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Bairro<select aria-label="Bairro" value={neighborhood} onChange={event => setNeighborhood(event.target.value)}><option value="">Todos os bairros</option>{neighborhoods.map(value => <option key={value}>{value}</option>)}</select></label>
      <button type="button" title="Limpar filtros" aria-label="Limpar filtros" onClick={() => { setSearch(''); setCity(''); setNeighborhood('') }}><RotateCcw size={19}/></button>
      <button type="button" title="Atualizar pontos" aria-label="Atualizar pontos" disabled={loading} onClick={() => setVersion(value => value + 1)}><RefreshCw size={19}/></button>
    </form>
    {error && <p role="alert">{error}</p>}
    <div className="pdm-workspace"><section className="pdm-results" aria-label="Drops ativos"><p role="status">{loading ? 'Carregando pontos...' : `${filtered.length} ponto(s) encontrado(s)`}</p>{!loading && !error && !filtered.length && <p>Nenhum ponto encontrado.</p>}{filtered.map(point => <article key={point.id}><h2><MapPin size={17}/>{point.name || 'Drop'}</h2><p>{addressOf(point)}</p><div><button type="button" onClick={() => map.current?.setView([Number(point.latitude), Number(point.longitude)], 16)}>Ver no mapa</button><a href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${point.latitude},${point.longitude}`)}&travelmode=driving`} target="_blank" rel="noreferrer"><Navigation size={16}/>Como chegar</a></div></article>)}</section><div className="pdm-map" ref={holder} aria-label="Mapa dos pontos de coleta"/></div>
    <footer>Movidos</footer>
  </main>
}