import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from './lib/supabase'
import { useAccess } from './access'
import PostalCodeLookup from './PostalCodeLookup'
import { MAIS_ENVIOS_FIELDS, MAIS_ENVIOS_STAGES, emptyMaisEnvios, maisEnviosError,
  maisEnviosPayload, maisEnviosSearch, type MaisEnviosField, type MaisEnviosRow, type MaisEnviosValues } from './maisEnviosData'
import './mais-envios.css'

const BASE = '/cadastros/mais-envios'
const TABLE = 'mais_envios_registrations'
const PAGE_SIZE = 25
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const labels: Record<MaisEnviosField, string> = {
  cnpj: 'CNPJ', smart: 'Smart (nome)', responsavel: 'Responsavel', telefone: 'Telefone',
  email: 'Email', endereco: 'Endereco', numero: 'Numero', complemento: 'Complemento',
  bairro: 'Bairro', cidade: 'Cidade', uf: 'UF', cep: 'CEP', tamanho_camiseta: 'Tamanho camiseta',
}
type StageEvent = { id: string; previous_stage: number | null; etapa: number; changed_by: string; changed_at: string }

function StageProgress({ etapa }: { etapa: number }) {
  return <ol className="me-stages" aria-label="Progresso do cadastro">
    {MAIS_ENVIOS_STAGES.map((label, index) => {
      const stage = index + 1
      const state = stage < etapa ? 'Concluida' : stage === etapa ? 'Atual' : 'Pendente'
      return <li key={label} className={`me-stage me-stage-${state.toLowerCase()}`} aria-current={stage === etapa ? 'step' : undefined}>
        <span className="me-stage-number" aria-hidden="true">{stage}</span>
        <span><small>{state}</small><span>{label}</span></span>
      </li>
    })}
  </ol>
}

function MaisEnviosList({ canCreate, canEdit }: { canCreate: boolean; canEdit: boolean }) {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState({ search: '', etapa: '', page: 0 })
  const [rows, setRows] = useState<MaisEnviosRow[]>([])
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const timer = setTimeout(() => setFilters(current => current.search === search ? current : { ...current, search, page: 0 }), 250)
    return () => clearTimeout(timer)
  }, [search])
  useEffect(() => {
    let current = true
    setLoading(true)
    setError('')
    setRows([])
    void (async () => {
      try {
        if (!supabase) throw new Error('Nao foi possivel conectar ao sistema.')
        let query = supabase.from(TABLE).select('*', { count: 'exact' })
        const expression = maisEnviosSearch(filters.search)
        if (expression) query = query.or(expression)
        if (filters.etapa) query = query.eq('etapa', Number(filters.etapa))
        const { data, count: total, error: failure } = await query.order('created_at', { ascending: false }).order('id')
          .range(filters.page * PAGE_SIZE, (filters.page + 1) * PAGE_SIZE - 1)
        if (failure) throw failure
        if (!current) return
        const lastPage = Math.max(0, Math.ceil((total ?? 0) / PAGE_SIZE) - 1)
        if (filters.page > lastPage) { setFilters(value => ({ ...value, page: lastPage })); return }
        setRows((data ?? []) as MaisEnviosRow[])
        setCount(total ?? 0)
      } catch (failure) { if (current) { setError(maisEnviosError(failure)); setCount(0) } }
      finally { if (current) setLoading(false) }
    })()
    return () => { current = false }
  }, [filters, refresh])
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE))
  return <>
    <header className="me-heading"><h1>Mais Envios</h1><div className="me-actions">
      <button type="button" onClick={() => setRefresh(value => value + 1)} disabled={loading}>Atualizar</button>
      {canCreate && <button type="button" className="me-primary" onClick={() => navigate(`${BASE}/novo`)}>Novo cadastro</button>}
    </div></header>
    <section className="me-filters" aria-label="Filtros Mais Envios">
      <label>Busca<input type="search" value={search} maxLength={100} onChange={event => setSearch(event.target.value)} /></label>
      <label>Etapa<select aria-label="Etapa" value={filters.etapa} onChange={event => setFilters(current => ({ ...current, etapa: event.target.value, page: 0 }))}>
        <option value="">Todas as etapas</option>
        {MAIS_ENVIOS_STAGES.map((label, index) => <option key={label} value={index + 1}>{index + 1}. {label}</option>)}
      </select></label>
      <button type="button" onClick={() => { setSearch(''); setFilters({ search: '', etapa: '', page: 0 }) }}>Limpar filtros</button>
    </section>
    {error && <p role="alert" className="me-error">{error}</p>}
    <div className="me-table-wrap" tabIndex={0} role="region" aria-label="Cadastros Mais Envios" aria-busy={loading}>
      <table className="me-table"><thead><tr><th>Smart</th><th>CNPJ</th><th>Responsavel</th><th>Contato</th><th>Cidade / UF</th><th>Etapa</th><th>Acoes</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id}>
          <td><strong>{row.smart}</strong></td><td>{row.cnpj || '-'}</td><td>{row.responsavel || '-'}</td>
          <td>{row.telefone || '-'}<small>{row.email}</small></td><td>{[row.cidade, row.uf].filter(Boolean).join(' / ') || '-'}</td>
          <td><span className="me-stage-label">{row.etapa}. {MAIS_ENVIOS_STAGES[row.etapa - 1]}</span></td>
          <td><button type="button" aria-label={`${canEdit ? 'Editar' : 'Ver'} ${row.smart}`} onClick={() => navigate(`${BASE}/novo?edit=${encodeURIComponent(row.id)}`)}>{canEdit ? 'Editar' : 'Ver'}</button></td>
        </tr>)}</tbody></table>
      {loading && <p role="status">Carregando cadastros...</p>}
      {!loading && !error && !rows.length && <p role="status">Nenhum cadastro encontrado.</p>}
    </div>
    <nav className="me-pagination" aria-label="Paginacao Mais Envios">
      <span>{count} cadastro{count === 1 ? '' : 's'} | Pagina {filters.page + 1} de {pages}</span>
      <div className="me-actions"><button type="button" disabled={loading || !!error || filters.page === 0} onClick={() => setFilters(current => ({ ...current, page: current.page - 1 }))}>Anterior</button>
        <button type="button" disabled={loading || !!error || filters.page + 1 >= pages} onClick={() => setFilters(current => ({ ...current, page: current.page + 1 }))}>Proxima</button></div>
    </nav>
  </>
}

function MaisEnviosForm({ editId, canCreate, canEdit }: { editId: string | null; canCreate: boolean; canEdit: boolean }) {
  const navigate = useNavigate()
  const [values, setValues] = useState<MaisEnviosValues>(emptyMaisEnvios)
  const [record, setRecord] = useState<MaisEnviosRow | null>(null)
  const [loading, setLoading] = useState(Boolean(editId))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const [history, setHistory] = useState<StageEvent[]>([])
  const [historyError, setHistoryError] = useState('')
  const [reload, setReload] = useState(0)
  const [historyReload, setHistoryReload] = useState(0)
  const busy = useRef(false)
  const newId = useRef(crypto.randomUUID())
  const canWrite = record || editId ? canEdit : canCreate
  const effectiveId = editId || (uncertain ? newId.current : null)
  useEffect(() => {
    if (!effectiveId) return
    let current = true
    setLoading(true)
    setError('')
    void (async () => {
      try {
        if (!UUID.test(effectiveId)) throw new Error('Identificador de cadastro invalido.')
        if (!supabase) throw new Error('Nao foi possivel conectar ao sistema.')
        const { data, error: failure } = await supabase.from(TABLE).select('*').eq('id', effectiveId).maybeSingle()
        if (failure) throw failure
        if (!current) return
        if (!data && editId) throw new Error('Cadastro nao encontrado ou sem acesso.')
        if (data) { setRecord(data as MaisEnviosRow); setValues(maisEnviosPayload(data as MaisEnviosRow)) }
        setUncertain(false)
        if (!editId && data) navigate(`${BASE}/novo?edit=${encodeURIComponent(data.id)}`, { replace: true })
      } catch (failure) { if (current) setError(maisEnviosError(failure)) }
      finally { if (current) setLoading(false) }
    })()
    return () => { current = false }
  }, [effectiveId, editId, reload, navigate])
  useEffect(() => {
    if (!record?.id) return
    let current = true
    setHistory([])
    setHistoryError('')
    void (async () => {
      try {
        if (!supabase) throw new Error('Nao foi possivel conectar ao sistema.')
        const { data, error: failure } = await supabase.from('mais_envios_stage_history').select('*').eq('registration_id', record.id)
          .order('changed_at', { ascending: false }).order('id').limit(100)
        if (failure) throw failure
        if (current) setHistory((data ?? []) as StageEvent[])
      } catch (failure) { if (current) setHistoryError(maisEnviosError(failure)) }
    })()
    return () => { current = false }
  }, [record, historyReload])
  const update = (field: MaisEnviosField, value: string) => setValues(current => ({ ...current, [field]: value }))
  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy.current || !canWrite || loading || uncertain || (editId && !record)) return
    setError('')
    setNotice('')
    let payload: MaisEnviosValues
    try { payload = maisEnviosPayload(values) }
    catch (failure) { setError(maisEnviosError(failure)); return }
    busy.current = true
    setSaving(true)
    try {
      if (!supabase) throw new Error('Nao foi possivel conectar ao sistema.')
      const query = record
        ? supabase.from(TABLE).update(payload).eq('id', record.id).eq('updated_at', record.updated_at)
        : supabase.from(TABLE).insert({ ...payload, id: newId.current })
      const { data, error: failure } = await query.select('*').maybeSingle()
      if (failure) throw failure
      if (!data) throw new Error('O cadastro mudou ou a permissao foi alterada. Recarregue antes de salvar novamente.')
      setRecord(data as MaisEnviosRow)
      setValues(maisEnviosPayload(data as MaisEnviosRow))
      setNotice('Cadastro salvo.')
      if (!editId) navigate(`${BASE}/novo?edit=${encodeURIComponent(data.id)}`, { replace: true })
    } catch (failure) {
      setUncertain(true)
      setError(`${maisEnviosError(failure)} A gravacao pode nao ter sido confirmada. Verifique o cadastro antes de tentar novamente.`)
    } finally { busy.current = false; setSaving(false) }
  }
  if (!editId && !canCreate && !record) return <p role="alert">Sem permissao para criar cadastros.</p>
  return <>
    <header className="me-heading"><h1>{editId ? 'Cadastro Mais Envios' : 'Novo Mais Envios'}</h1>
      <button type="button" disabled={saving} onClick={() => navigate(BASE)}>Voltar para lista</button></header>
    <StageProgress etapa={values.etapa} />
    {loading && <p role="status">Carregando cadastro...</p>}
    {error && <p className="me-error" role="alert">{error}</p>}
    {notice && <p className="me-success" role="status">{notice}</p>}
    {(uncertain || (editId && !record && !loading)) && <button type="button" disabled={saving || loading} onClick={() => setReload(value => value + 1)}>Verificar cadastro</button>}
    <form className="me-form" onSubmit={save}>
      <fieldset disabled={loading || saving || !canWrite || uncertain || Boolean(editId && !record)}>
        <legend>Dados do cadastro</legend>
        <label className="me-full">Status / etapa<select aria-label="Status / etapa" value={values.etapa} onChange={event => setValues(current => ({ ...current, etapa: Number(event.target.value) }))}>
          {MAIS_ENVIOS_STAGES.map((label, index) => <option key={label} value={index + 1}>{index + 1}. {label}</option>)}
        </select></label>
        <div className="me-fields">
          {MAIS_ENVIOS_FIELDS.filter(field => field !== 'cep' && !['endereco', 'numero', 'complemento', 'bairro', 'cidade', 'uf'].includes(field)).map(field =>
            <label key={field}>{labels[field]}<input name={field} value={values[field]} required={field === 'smart'} maxLength={300}
              type={field === 'email' ? 'email' : field === 'telefone' ? 'tel' : 'text'}
              inputMode={field === 'cnpj' ? 'numeric' : undefined} onChange={event => update(field, event.target.value)} /></label>)}
        </div>
        <div className="me-address">
          <PostalCodeLookup value={values.cep} onChange={value => update('cep', value)}
            address={{ street: values.endereco, neighborhood: values.bairro, city: values.cidade, state: values.uf }}
            onAddress={address => setValues(current => ({ ...current, endereco: address.street, bairro: address.neighborhood, cidade: address.city, uf: address.state }))} />
        </div>
        <div className="me-fields">
          {(['endereco', 'numero', 'complemento', 'bairro', 'cidade', 'uf'] as const).map(field =>
            <label key={field}>{labels[field]}<input name={field} value={values[field]} maxLength={field === 'uf' ? 2 : 300}
              onChange={event => update(field, event.target.value)} /></label>)}
        </div>
      </fieldset>
      <div className="me-actions">
        {canWrite && <button type="submit" className="me-primary" disabled={loading || saving || uncertain || Boolean(editId && !record)}>{saving ? 'Salvando...' : 'Salvar cadastro'}</button>}
        <button type="button" disabled={loading || saving || !record} onClick={() => setReload(value => value + 1)}>Recarregar cadastro</button>
      </div>
    </form>
    {record && <section className="me-history" aria-label="Historico de etapas">
      <div className="me-heading"><h2>Historico de etapas</h2><button type="button" onClick={() => setHistoryReload(value => value + 1)}>Atualizar historico</button></div>
      {historyError && <p role="alert" className="me-error">{historyError}</p>}
      <ol>{history.map(entry => <li key={entry.id}>
        <strong>{entry.previous_stage === null ? 'Cadastro criado' : `Etapa ${entry.previous_stage} para ${entry.etapa}`}</strong>
        <span>{MAIS_ENVIOS_STAGES[entry.etapa - 1]}</span>
        <time dateTime={entry.changed_at}>{new Date(entry.changed_at).toLocaleString('pt-BR')}</time>
        <small>Usuario: {entry.changed_by}</small>
      </li>)}</ol>
    </section>}
  </>
}

export default function MaisEnvios({ view = 'list' }: { view?: 'list' | 'form' }) {
  const { loading, can, profile } = useAccess()
  const [params] = useSearchParams()
  const editId = params.get('edit')
  useLayoutEffect(() => {
    const existing = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    const viewport = existing ?? document.createElement('meta')
    const previous = viewport.getAttribute('content')
    viewport.name = 'viewport'
    viewport.content = 'width=device-width, initial-scale=1'
    if (!existing) document.head.appendChild(viewport)
    return () => {
      if (!existing) viewport.remove()
      else if (previous === null) viewport.removeAttribute('content')
      else viewport.content = previous
    }
  }, [])
  const allowed = Boolean(profile?.is_active && can('cadastros_view'))
  return <div className="mais-envios">
    {loading ? <p role="status">Carregando permissoes...</p> : !allowed ? <p role="alert">Sem permissao para acessar Mais Envios.</p>
      : view === 'form' ? <MaisEnviosForm key={editId ?? 'new'} editId={editId} canCreate={can('cadastros_create')} canEdit={can('cadastros_edit')} />
        : <MaisEnviosList canCreate={can('cadastros_create')} canEdit={can('cadastros_edit')} />}
  </div>
}