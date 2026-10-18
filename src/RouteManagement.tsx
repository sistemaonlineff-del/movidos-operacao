// @ts-nocheck
import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from './lib/supabase'
import './route-management.css'
import { routeIdentity, routeImportPlan } from './routeImport'

type BaseRow = { id?: string; street: string; neighborhood: string; city: string; postal_code: string; zone: string; route: string; delivery_sequence?: number | null; latitude?: number | null; longitude?: number | null; is_active?: boolean }
type Volume = { id?: string; delivery_date: string; zone: string; route: string; batch_number: number; driver_name: string; recipient: string; street: string; neighborhood: string; city: string; postal_code: string; delivery_sequence?: number | null }
const blankBase = (): BaseRow => ({ street: '', neighborhood: '', city: '', postal_code: '', zone: '', route: 'A definir', delivery_sequence: null, latitude: null, longitude: null, is_active: true })
const blankVolume = (): Volume => ({ delivery_date: new Date().toISOString().slice(0, 10), zone: '', route: '', batch_number: 1, driver_name: '', recipient: '', street: '', neighborhood: '', city: '', postal_code: '', delivery_sequence: null })
const normalize = (value: unknown) => String(value ?? '').trim()
const cep = (value: unknown) => normalize(value).replace(/\D/g, '').slice(0, 8).replace(/(\d{5})(\d)/, '$1-$2')
const key = (value: unknown) => normalize(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '')
const pick = (row: Record<string, unknown>, names: string[]) => { const entry = Object.entries(row).find(([name]) => names.includes(key(name))); return entry ? normalize(entry[1]) : '' }
const planKey = (row: Volume) => `${row.delivery_date}|${row.zone}|${row.route}|${row.batch_number}`
const byDeliverySequence = (a: Volume, b: Volume) => (a.delivery_sequence ?? Number.MAX_SAFE_INTEGER) - (b.delivery_sequence ?? Number.MAX_SAFE_INTEGER) || a.postal_code.localeCompare(b.postal_code, 'pt-BR', { numeric: true }) || a.street.localeCompare(b.street, 'pt-BR')

export default function RouteManagement() {
  const [base, setBase] = useState<BaseRow[]>([])
  const [volumes, setVolumes] = useState<Volume[]>([])
  const [baseValue, setBaseValue] = useState<BaseRow>(blankBase)
  const [volumeValue, setVolumeValue] = useState<Volume>(blankVolume)
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const readBase = async () => {
    const rows:BaseRow[]=[]
    for(let start=0;;start+=1000){const result=await supabase!.from('delivery_route_base').select('*').order('id').range(start,start+999);if(result.error)return result;rows.push(...result.data);if(result.data.length<1000)return {data:rows,error:null}}
  }
  const load = async () => {
    if (!supabase) return
    setLoading(true); setMessage('')
    const [baseResult, volumeResult] = await Promise.all([
      readBase(),
      supabase.from('delivery_volumes').select('*').eq('delivery_date', date).order('zone').order('route').order('batch_number').order('delivery_sequence').order('postal_code'),
    ])
    if (baseResult.error || volumeResult.error) setMessage('A base de rotas ainda não foi preparada. Execute o arquivo supabase/06_delivery_routes.sql no SQL Editor do Supabase.')
    else { setBase(baseResult.data ?? []); setVolumes(volumeResult.data ?? []) }
    setLoading(false)
  }
  useEffect(() => { void load() }, [date])
  const plans = useMemo(() => {
    const groups = new Map<string, Volume[]>()
    volumes.forEach(row => { const values = groups.get(planKey(row)) ?? []; values.push(row); groups.set(planKey(row), values) })
    return [...groups.entries()].map(([id, rows]) => ({ id, rows: [...rows].sort(byDeliverySequence), zone: rows[0].zone, route: rows[0].route, batch: rows[0].batch_number, driver: rows[0].driver_name || '' })).sort((a, b) => a.zone.localeCompare(b.zone) || a.route.localeCompare(b.route) || a.batch - b.batch)
  }, [volumes])
  const filtered = useMemo(() => { const term = key(query); return term ? base.filter(row => key([row.street, row.neighborhood, row.city, row.postal_code, row.zone, row.route, row.delivery_sequence].join(' ')).includes(term)) : base }, [base, query])
  const saveBase = async (event: FormEvent) => {
    event.preventDefault(); if (!supabase || !baseValue.zone) { setMessage('Informe ao menos a zona.'); return }
    if(base.some(row=>row.is_active!==false&&row.id!==baseValue.id&&routeIdentity(row)===routeIdentity(baseValue))){setMessage('Endereço-base duplicado nesta zona e rota. Edite o existente.');return}
    setSaving(true); const { id, ...payload } = baseValue
    const result = id ? await supabase.from('delivery_route_base').update(payload).eq('id', id) : await supabase.from('delivery_route_base').insert(payload)
    setSaving(false); if (result.error) setMessage(result.error.message); else { setBaseValue(blankBase()); setMessage('Endereço-base salvo.'); await load() }
  }
  const importBase = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file || !supabase) return
    let saved=0, filled=0
    setSaving(true)
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' }); const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' }).map(row => ({
        street: pick(row, ['rua', 'logradouro', 'endereco', 'endereço']), neighborhood: pick(row, ['bairro']), city: pick(row, ['cidade', 'municipio', 'município']), postal_code: cep(pick(row, ['cep', 'postalcode', 'codigopostal', 'código postal'])), zone: pick(row, ['zona', 'regiao', 'região', 'zone']), route: pick(row, ['rota', 'route']) || 'A definir', delivery_sequence: Number(pick(row, ['sequencia', 'sequência', 'ordem'])) || null, latitude: Number(pick(row, ['latitude', 'lat'])) || null, longitude: Number(pick(row, ['longitude', 'longitude', 'lng', 'lon'])) || null, is_active: true,
      })).filter(row => row.zone)
      if (!rows.length) throw new Error('Não encontrei linhas com a coluna Zona. Confira o cabeçalho do Excel.')
      const current=await readBase()
      if(current.error)throw current.error
      const plan=routeImportPlan(current.data,rows)
      if(plan.fills.length&&!confirm(`Preencher ${plan.fills.length} CEP(s) vazio(s) com os valores da planilha? Os CEPs já preenchidos e os demais campos serão preservados.`)){setMessage('Importação cancelada. Nenhum endereço alterado.');return}
      for(const fill of plan.fills){
        let update=supabase.from('delivery_route_base').update({postal_code:fill.postal_code}).eq('id',fill.id).eq('is_active',true)
        update=fill.previous===null?update.is('postal_code',null):update.eq('postal_code',fill.previous)
        const result=await update.select('id')
        if(result.error||result.data?.length!==1)throw new Error('Um CEP mudou durante a importação. Confira a base antes de repetir.')
        filled++
      }
      const unique=plan.inserts
      for (let start = 0; start < unique.length; start += 250) { const part=unique.slice(start,start+250);const result = await supabase.from('delivery_route_base').insert(part); if (result.error) throw result.error;saved+=part.length }
      await load();setMessage(`${saved} endereço(s) importado(s); ${filled} CEP(s) vazio(s) preenchido(s); ${plan.skipped} duplicado(s) ignorado(s).`)
    } catch (error) { setMessage(`${saved} endereço(s) e ${filled} CEP(s) confirmado(s). ${error?.message||'Não foi possível importar a planilha.'} Atualize os dados antes de repetir.`) } finally { setSaving(false) }
  }
  const clearPostalCodes=async()=>{
    if(!supabase||saving)return
    const ids=filtered.filter(row=>row.is_active!==false&&normalize(row.postal_code)).map(row=>row.id)
    if(!ids.length)return
    const reason=prompt(`Esvaziar os CEPs de ${ids.length} endereço(s) filtrado(s)? Informe o motivo (mínimo 5 caracteres).`)
    if(!reason)return
    setSaving(true)
    const {data,error}=await supabase.rpc('clear_route_postal_codes',{route_ids:ids,reason})
    if(!error)await load()
    setMessage(error?.message??`${data} CEP(s) esvaziado(s). Valores anteriores preservados na auditoria.`);setSaving(false)
  }
  const saveVolume = async (event: FormEvent) => {
    event.preventDefault(); if (!supabase || !volumeValue.zone || !volumeValue.route) { setMessage('Informe zona e rota do volume.'); return }
    const sameRoute = volumes.filter(row => row.zone === volumeValue.zone && row.route === volumeValue.route)
    const batch = Math.floor(sameRoute.length / 100) + 1
    setSaving(true); const result = await supabase.from('delivery_volumes').insert({ ...volumeValue, delivery_date: date, postal_code: cep(volumeValue.postal_code), batch_number: batch, driver_name: volumeValue.driver_name || null })
    setSaving(false); if (result.error) setMessage(result.error.message); else { setVolumeValue(blankVolume()); setMessage(`Volume salvo no lote ${batch}.`); await load() }
  }
  const organizeBySequence = async () => {
    if (!supabase || !volumes.length) return
    setSaving(true); setMessage('Organizando lotes pela sequência da planilha...')
    try {
      const groups = new Map<string, Volume[]>()
      volumes.forEach(row => { const group = groups.get(`${row.zone}|${row.route}`) ?? []; group.push(row); groups.set(`${row.zone}|${row.route}`, group) })
      for (const rows of groups.values()) {
        const ordered = [...rows].sort(byDeliverySequence)
        for (let index = 0; index < ordered.length; index++) { const row = ordered[index]; const result = await supabase.from('delivery_volumes').update({ batch_number: 1000 + index }).eq('id', row.id); if (result.error) throw result.error }
        for (let index = 0; index < ordered.length; index++) { const row = ordered[index]; const result = await supabase.from('delivery_volumes').update({ batch_number: Math.floor(index / 100) + 1 }).eq('id', row.id); if (result.error) throw result.error }
      }
      setMessage('Pré-rotas organizadas pela sequência da planilha, com até 100 volumes por lote.'); await load()
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Não foi possível organizar as pré-rotas.') } finally { setSaving(false) }
  }
  const setDriver = async (plan: any, driver: string) => {
    if (!supabase) return
    const normalized = driver.trim().toLowerCase(); const occupied = volumes.filter(row => row.driver_name?.trim().toLowerCase() === normalized && planKey(row) !== plan.id).length
    if (normalized && occupied + plan.rows.length > 100) { setMessage(`${driver} já possui ${occupied} volumes; este lote ultrapassaria o máximo de 100.`); return }
    setSaving(true)
    for (const row of plan.rows) { const result = await supabase.from('delivery_volumes').update({ driver_name: driver.trim() || null }).eq('id', row.id); if (result.error) { setMessage(result.error.message); break } }
    setSaving(false); await load()
  }
  const exportPlans = () => {
    const workbook = XLSX.utils.book_new()
    plans.forEach(plan => { const title = `${plan.zone}-${plan.route}-${plan.batch}`.slice(0, 31); XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(plan.rows.map((row, index) => ({ Ordem: index + 1, Sequência: row.delivery_sequence ?? '', Motorista: plan.driver, Zona: row.zone, Rota: row.route, Lote: row.batch_number, CEP: row.postal_code, Cidade: row.city, Bairro: row.neighborhood, Rua: row.street, Destinatário: row.recipient }))), title) })
    XLSX.writeFile(workbook, `pre-rotas-${date}.xlsx`)
  }
  if (loading) return <section className="card">Carregando base de rotas...</section>
  return <section className="route-management"><div className="route-title"><div><p className="eyebrow">OPERAÇÃO DE ENTREGA</p><h2>Base e pré-rotas</h2></div><label className={`secondary route-import ${saving ? 'disabled' : ''}`}>Importar Excel<input type="file" accept=".xlsx,.xls,.csv" disabled={saving} onChange={event => void importBase(event)} hidden /></label></div>{message && <p role="status" className="form-message">{message}</p>}
    <button type="button" disabled={saving||!filtered.some(row=>row.is_active!==false&&normalize(row.postal_code))} onClick={()=>void clearPostalCodes()}>Esvaziar CEPs filtrados</button>
    <section className="card"><h3>Base de endereços</h3><form className="route-form" onSubmit={saveBase}><input placeholder="Rua (opcional)" value={baseValue.street} onChange={e => setBaseValue({ ...baseValue, street: e.target.value })}/><input placeholder="Bairro" value={baseValue.neighborhood} onChange={e => setBaseValue({ ...baseValue, neighborhood: e.target.value })}/><input placeholder="Cidade" value={baseValue.city} onChange={e => setBaseValue({ ...baseValue, city: e.target.value })}/><input placeholder="CEP" value={baseValue.postal_code} onChange={e => setBaseValue({ ...baseValue, postal_code: cep(e.target.value) })}/><input required placeholder="Zona" value={baseValue.zone} onChange={e => setBaseValue({ ...baseValue, zone: e.target.value })}/><input required placeholder="Rota" value={baseValue.route} onChange={e => setBaseValue({ ...baseValue, route: e.target.value })}/><input type="number" min="1" placeholder="Sequência" value={baseValue.delivery_sequence ?? ''} onChange={e => setBaseValue({ ...baseValue, delivery_sequence: e.target.value ? Number(e.target.value) : null })}/><button className="primary" disabled={saving}>{baseValue.id ? 'Salvar edição' : 'Adicionar endereço'}</button>{baseValue.id && <button type="button" onClick={() => setBaseValue(blankBase())}>Cancelar</button>}</form><input className="route-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar CEP, bairro, cidade, zona, rota ou sequência"/><div className="table-wrap"><table><thead><tr><th>CEP</th><th>Bairro</th><th>Cidade</th><th>Zona</th><th>Rota</th><th>Sequência</th><th></th></tr></thead><tbody>{filtered.slice(0, 300).map(row => <tr key={row.id}><td>{row.postal_code}</td><td>{row.neighborhood}</td><td>{row.city}</td><td>{row.zone}</td><td>{row.route}</td><td>{row.delivery_sequence ?? '—'}</td><td><button className="table-action" onClick={() => setBaseValue(row)}>Editar</button></td></tr>)}</tbody></table></div>{filtered.length > 300 && <p className="label-muted">Mostrando os primeiros 300 resultados. Use a busca para reduzir a lista.</p>}</section>
    <section className="card"><h3>Volumes e pré-rota</h3><div className="route-toolbar"><label>Data<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label><button onClick={() => void organizeBySequence()} disabled={saving || !volumes.length}>Organizar pela sequência</button><button className="secondary" onClick={exportPlans} disabled={!plans.length}>Exportar pré-rotas</button></div><form className="route-form" onSubmit={saveVolume}><input placeholder="Destinatário" value={volumeValue.recipient} onChange={e => setVolumeValue({ ...volumeValue, recipient: e.target.value })}/><input placeholder="Rua" value={volumeValue.street} onChange={e => setVolumeValue({ ...volumeValue, street: e.target.value })}/><input placeholder="Bairro" value={volumeValue.neighborhood} onChange={e => setVolumeValue({ ...volumeValue, neighborhood: e.target.value })}/><input placeholder="Cidade" value={volumeValue.city} onChange={e => setVolumeValue({ ...volumeValue, city: e.target.value })}/><input placeholder="CEP" value={volumeValue.postal_code} onChange={e => setVolumeValue({ ...volumeValue, postal_code: cep(e.target.value) })}/><input required placeholder="Zona" value={volumeValue.zone} onChange={e => setVolumeValue({ ...volumeValue, zone: e.target.value })}/><input required placeholder="Rota" value={volumeValue.route} onChange={e => setVolumeValue({ ...volumeValue, route: e.target.value })}/><input type="number" min="1" placeholder="Sequência" value={volumeValue.delivery_sequence ?? ''} onChange={e => setVolumeValue({ ...volumeValue, delivery_sequence: e.target.value ? Number(e.target.value) : null })}/><button className="primary" disabled={saving}>Salvar volume</button></form><div className="route-plans">{plans.map(plan => <article key={plan.id}><h4>{plan.zone} · Rota {plan.route} · Lote {plan.batch}</h4><strong>{plan.rows.length}/100 volumes</strong><label>Motorista<input defaultValue={plan.driver} onBlur={e => void setDriver(plan, e.target.value)} placeholder="Definir motorista" /></label><p>{plan.rows.slice(0, 4).map(row => row.delivery_sequence ? `Seq. ${row.delivery_sequence}` : row.postal_code).filter(Boolean).join(' · ')}{plan.rows.length > 4 && ' · ...'}</p></article>)}{!plans.length && <p>Os volumes do dia aparecerão aqui na sequência da planilha, em lotes de no máximo 100 entregas.</p>}</div></section>
  </section>
}
