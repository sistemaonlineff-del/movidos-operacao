import { useEffect, useRef, useState } from 'react'
import { Check, Download, Navigation, RefreshCw, Route } from 'lucide-react'
import * as XLSX from 'xlsx'
import { supabase } from './lib/supabase'
import { brazilDay, dispatchAddress, dispatchMapsLinks, dispatchSpreadsheetRows, type DispatchDriver, type DispatchVolume } from './labelDispatch'
import './label-dispatch.css'

type Data = { rows: DispatchVolume[]; drivers: DispatchDriver[]; dispatcher: boolean; currentUserId: string; optimizationConfigured: boolean }
export default function LabelDispatchPanel({ driverId, onDriverChange, revision }: { driverId: string; onDriverChange: (id: string) => void; revision: number }) {
  const [day, setDay] = useState(brazilDay), [data, setData] = useState<Data | null>(null), [viewDriver, setViewDriver] = useState('')
  const [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState(''), [origin, setOrigin] = useState('')
  const [drafts, setDrafts] = useState<Record<string,string>>({}), [optimized, setOptimized] = useState<string[]>([])
  const request = useRef(0)
  const loadedDay = useRef(day)
  const viewInitialized = useRef(false)
  const api = async (payload?: Record<string,unknown>) => {
    const session = await supabase!.auth.getSession()
    const response = await fetch(payload ? '/api/label-dispatch' : `/api/label-dispatch?day=${encodeURIComponent(day)}`, { method: payload ? 'POST' : 'GET', headers: { Authorization: `Bearer ${session.data.session?.access_token ?? ''}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify({ ...payload, day }) } : {}), cache: 'no-store' })
    if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('Expedicao indisponivel neste ambiente.')
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Falha ao carregar expedicao.')
    return result
  }
  useEffect(() => {
    const current = ++request.current
    setBusy(true); setError(''); setOptimized([])
    if (loadedDay.current !== day) { loadedDay.current = day; setData(null); setDrafts({}) }
    void api().then((result: Data) => {
      if (current !== request.current) return
      setData(result)
      if (!driverId) onDriverChange(result.currentUserId)
      if (!result.dispatcher) setViewDriver(result.currentUserId)
      else if (!viewInitialized.current) setViewDriver(driverId || result.currentUserId)
      viewInitialized.current = true
    }).catch(failure => { if (current === request.current) setError(failure instanceof Error ? failure.message : 'Expedicao indisponivel.') }).finally(() => { if (current === request.current) setBusy(false) })
    return () => { request.current++ }
  }, [day, refresh, revision])
  const rows = data?.rows.filter(row => viewDriver === 'unassigned' ? !row.driver_id : !viewDriver || row.driver_id === viewDriver) ?? []
  const selected = optimized.length ? optimized.map(id => rows.find(row => row.id === id)).filter((row): row is DispatchVolume => Boolean(row)) : rows
  const exportable = Boolean(viewDriver && viewDriver !== 'unassigned' && selected.length && selected.every(row => row.address_confirmed && row.recipient_address && drafts[row.id] === undefined))
  let links: string[] = []
  let linkError = ''
  if (exportable) { try { links = dispatchMapsLinks(selected, origin) } catch (failure) { linkError = (failure as Error).message } }
  const counts = new Map<string,{name:string;count:number}>()
  for (const row of data?.rows ?? []) { const key = row.driver_id || 'unassigned', group = counts.get(key) ?? { name: row.driver_name || (row.driver_id ? 'Motorista' : 'Historico sem motorista'), count: 0 }; group.count++; counts.set(key,group) }
  const confirmAddress = async (row: DispatchVolume) => {
    const current = request.current
    setError(''); setBusy(true)
    try { await api({ mode: 'confirm-address', id: row.id, address: drafts[row.id] ?? dispatchAddress(row) }); if (current === request.current) { setDrafts(previous => { const next = {...previous}; delete next[row.id]; return next }); setRefresh(value => value + 1) } }
    catch (failure) { setError((failure as Error).message) } finally { setBusy(false) }
  }
  const optimize = async () => {
    if (!window.confirm('Otimizar as paradas intermediarias no Google, mantendo a ultima parada como destino final? Os enderecos serao enviados ao Google e a conta configurada podera ser cobrada.')) return
    setBusy(true); setError('')
    const current = request.current
    try { const result = await api({ mode: 'optimize', driverId: viewDriver, origin }); if (current === request.current) setOptimized(result.ids) }
    catch (failure) { setError((failure as Error).message) } finally { setBusy(false) }
  }
  const excel = () => {
    if (!selected.length) return
    if (selected.some(row => drafts[row.id] !== undefined)) { setError('Confirme os enderecos alterados antes de exportar.'); return }
    const sheet = XLSX.utils.aoa_to_sheet(dispatchSpreadsheetRows(selected, day))
    sheet['!cols'] = [{wch:24},{wch:12},{wch:8},{wch:18},{wch:60},{wch:12},{wch:20},{wch:38}]
    const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook,sheet,'Pacotes'); XLSX.writeFile(workbook,`pacotes-${day}.xlsx`)
  }
  return <section className="label-dispatch" id="label-dispatch" tabIndex={-1}>
    <header><h2><Route size={21}/>Expedicao por motorista</h2><button type="button" title="Atualizar expedicao" aria-label="Atualizar expedicao" disabled={busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={18}/></button></header>
    <div className="ld-controls"><label>Dia das leituras<input aria-label="Dia das leituras" type="date" value={day} onChange={event => { setDay(event.target.value); setOptimized([]) }}/></label>{data && <label>Motorista das proximas leituras<select aria-label="Motorista das proximas leituras" value={driverId} disabled={!data.dispatcher} onChange={event => onDriverChange(event.target.value)}>{data.drivers.map(driver => <option key={driver.id} value={driver.id}>{driver.name}</option>)}</select></label>}</div>
    {error && <p role="alert">{error}</p>}{busy && <p role="status">Atualizando expedicao...</p>}
    {data && <><div className="ld-totals"><span><strong>{data.rows.length}</strong> volumes bipados</span><span><strong>{[...counts.keys()].filter(key => key !== 'unassigned').length}</strong> motoristas com volumes</span><span><strong>{counts.get('unassigned')?.count ?? 0}</strong> sem motorista</span></div>
      <div className="ld-driver-totals">{[...counts.entries()].map(([key,group]) => <button type="button" key={key} onClick={() => { setViewDriver(key); setOptimized([]) }}>{group.name}: {group.count}</button>)}</div>
      <div className="ld-controls"><label>Lista do motorista<select aria-label="Lista do motorista" value={viewDriver} onChange={event => { setViewDriver(event.target.value); setOptimized([]) }}>{data.dispatcher && <><option value="">Todos</option><option value="unassigned">Historico sem motorista</option></>}{[...new Map([...data.drivers,...data.rows.filter(row => row.driver_id).map(row => ({ id: row.driver_id!, name: row.driver_name || 'Motorista' }))].map(driver => [driver.id,driver])).values()].map(driver => <option key={driver.id} value={driver.id}>{driver.name}</option>)}</select></label><label>Endereco de partida<input aria-label="Endereco de partida" value={origin} maxLength={500} onChange={event => { setOrigin(event.target.value); setOptimized([]) }}/></label><button type="button" disabled={!selected.length} onClick={excel}><Download size={17}/>Excel</button>{data.optimizationConfigured && <button type="button" disabled={busy || !exportable || !origin.trim() || rows.length < 2 || rows.length > 25} onClick={() => void optimize()}><Navigation size={17}/>Otimizar no Google</button>}</div>
      <p className="ld-note">{optimized.length ? 'Paradas intermediarias otimizadas pelo Google; destino final mantido.' : 'Ordem da sequencia cadastrada na base; paradas sem sequencia ficam por horario de leitura.'} Volumes atribuidos nao significam entregas concluidas.</p>
      {linkError && <p role="alert">{linkError}</p>}
      {links.length > 0 && <div className="ld-links">{links.map((link,index) => <a key={link} href={link} target="_blank" rel="noreferrer"><Navigation size={16}/>Google Maps: trecho {index+1}/{links.length}</a>)}</div>}
      {links.length === 0 && <div className="ld-links"><button type="button" disabled><Navigation size={16} aria-hidden="true"/>Google Maps</button></div>}
      {!exportable && selected.length > 0 && <p className="ld-note">Selecione um motorista e confira os enderecos completos, incluindo numero, antes de abrir as paradas no Maps.</p>}
      {!rows.length && <p>Nenhuma leitura encontrada para este filtro.</p>}
      <div className="ld-table"><table><thead><tr><th>Motorista</th><th>Endereco do pacote</th><th>Foto</th><th>Sequencia</th><th>Conferencia</th></tr></thead><tbody>{selected.map(row => <tr key={row.id}><td>{row.driver_name || 'Sem motorista'}</td><td>{row.driver_id ? <input aria-label={`Endereco do pacote ${row.id}`} value={drafts[row.id] ?? dispatchAddress(row)} maxLength={2000} onChange={event => { setDrafts(previous => ({...previous,[row.id]:event.target.value})); setOptimized([]) }}/>:dispatchAddress(row)}</td><td>{row.capture_number == null ? '-' : `#${row.capture_number}`}</td><td>{row.delivery_sequence ?? '-'}</td><td>{row.address_confirmed && drafts[row.id] === undefined ? 'Conferido' : row.driver_id && <button type="button" title="Confirmar endereco completo" aria-label={`Confirmar endereco ${row.id}`} disabled={busy || !(drafts[row.id] ?? dispatchAddress(row)).trim()} onClick={() => void confirmAddress(row)}><Check size={17}/></button>}</td></tr>)}</tbody></table></div>
    </>}
  </section>
}