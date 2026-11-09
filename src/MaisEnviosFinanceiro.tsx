import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { Download, FileDown, Mail, Plus, RefreshCw, Save, Send, Upload } from 'lucide-react'
import PizZip from 'pizzip'
import { supabase } from './lib/supabase'
import { useAccess } from './access'
import { downloadOutlookDraft, safeFileName } from './emailDraft'
import { assertMaisEnviosClosing, importMaisEnviosCsv, maisEnviosCodeValidity, maisEnviosPostingValidity, maisEnviosSmartKey, maisEnviosSummaries, validateMaisEnviosRows,
  type MaisEnviosClosing, type MaisEnviosClosingContact, type MaisEnviosClosingRow } from './maisEnviosClosing'
import { createMaisEnviosPdf, maisEnviosMarketHeaders, maisEnviosMoney, maisEnviosPostingHeaders, maisEnviosValidityLabel } from './maisEnviosReport'
import './mais-envios-financeiro.css'

type Registration = { id: string; smart: string; email: string; responsavel: string }
type MailLog = { smart_key: string; status: string; error_message?: string }
const BASE = '/financeiro/mais-envios'
const message = (error: unknown) => error && typeof error === 'object' && 'message' in error ? String(error.message) : 'Nao foi possivel concluir a operacao.'
const defaultBody = (period: string) => `Boa tarde!\n\nSegue em anexo o fechamento da Mais Envios referente ao periodo ${period}. O Resultado final mostra se ha valores a pagar ou a receber.\n\nEm caso de duvidas, estou a disposicao.\n\nAtenciosamente,`
const fingerprint = (closing: MaisEnviosClosing) => JSON.stringify([closing.id, closing.period, closing.subject, closing.body,
  closing.rows.map(row => [row.id, row.kind, row.period, row.values, row.originalCode, row.code, row.smart, row.createdAt, row.valueCents, row.validity, row.manual]),
  closing.contacts.map(contact => [contact.smart, contact.email, contact.responsible, contact.registrationId])])

async function readAll<T>(table: string, columns = '*', order = 'id'): Promise<T[]> {
  if (!supabase) throw new Error('Conexao indisponivel.')
  const rows: T[] = []
  for (let offset = 0; ; offset += 100) {
    const result = await supabase.from(table).select(columns).order(order).order('id').range(offset, offset + 99)
    if (result.error) throw result.error
    rows.push(...result.data as T[])
    if (result.data.length < 100) return rows
  }
}

export default function MaisEnviosFinanceiro() {
  const access = useAccess(), location = useLocation()
  const details = location.pathname.endsWith('/pagamento-detalhes')
  const manage = Boolean(access.profile?.is_active && access.can('financeiro_manage'))
  const view = Boolean(access.profile?.is_active && access.can('financeiro_view'))
  const [history, setHistory] = useState<MaisEnviosClosing[]>([]), [registrations, setRegistrations] = useState<Registration[]>([])
  const [draft, setDraft] = useState<MaisEnviosClosing | null>(null), [savedId, setSavedId] = useState('')
  const [loading, setLoading] = useState(true), [loadFailed, setLoadFailed] = useState(false), [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(''), [error, setError] = useState(''), [postingSmart, setPostingSmart] = useState('')
  const [smart, setSmart] = useState(''), [kind, setKind] = useState<'marketplace' | 'posting'>('marketplace'), [validity, setValidity] = useState(''), [page, setPage] = useState(0)
  const [mailLogs, setMailLogs] = useState<MailLog[]>([])
  const lock = useRef(false), alive = useRef(true)
  const current = draft ?? history.find(row => row.id === savedId) ?? null
  const saved = Boolean(current && !draft)
  const historyRows = history.flatMap(closing => closing.rows)
  const summaries = current ? maisEnviosSummaries(current.rows, current.period) : []
  const pending = current?.rows.filter(row => row.validity === 'pending' || !row.smart.trim()).length ?? 0
  const smartNames = [...new Set([...registrations.map(row => row.smart), ...(current?.rows.map(row => row.smart) ?? [])].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'))
  const visible = current?.rows.filter(row => row.kind === kind && (!smart || maisEnviosSmartKey(row.smart) === maisEnviosSmartKey(smart)) && (!validity || row.validity === validity)) ?? []
  const pages = Math.max(1, Math.ceil(visible.length / 50)), actualPage = Math.min(page, pages - 1)
  const load = async () => {
    setLoading(true); setLoadFailed(false); setError('')
    try {
      const [closings, contacts] = await Promise.all([readAll<MaisEnviosClosing>('mais_envios_closings', '*', 'created_at'), access.can('cadastros_view') ? readAll<Registration>('mais_envios_registrations', 'id,smart,email,responsavel', 'smart') : Promise.resolve([])])
      if (alive.current) { setHistory(closings); setRegistrations(contacts) }
    } catch { if (alive.current) { setLoadFailed(true); setError('Nao foi possivel carregar Mais Envios. Confira a conexao e a migracao 20261109130000_mais_envios_closings.sql antes de importar.') } }
    finally { if (alive.current) setLoading(false) }
  }
  useEffect(() => { alive.current = true; if (view) void load(); else setLoading(false); return () => { alive.current = false } }, [view])
  useEffect(() => {
    if (!draft?.rows.length) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [draft?.rows.length])
  useEffect(() => {
    let active = true
    setMailLogs([])
    if (savedId && !draft && supabase) void supabase.from('mais_envios_closing_mail').select('smart_key,status,error_message').eq('closing_id', savedId).then(result => {
      if (!active) return
      if (result.error) setError('Nao foi possivel conferir os envios anteriores. Confira antes de disparar.')
      else setMailLogs(result.data ?? [])
    })
    return () => { active = false }
  }, [savedId, Boolean(draft)])
  const withRows = (closing: MaisEnviosClosing, rows: MaisEnviosClosingRow[]) => {
    const validated = validateMaisEnviosRows(rows, historyRows)
    const contacts = maisEnviosSummaries(validated, closing.period).map(summary => {
      const previous = closing.contacts.find(contact => maisEnviosSmartKey(contact.smart) === maisEnviosSmartKey(summary.smart))
      if (previous) return previous
      const matches = registrations.filter(row => maisEnviosSmartKey(row.smart) === maisEnviosSmartKey(summary.smart))
      return { smart: summary.smart, email: matches.length === 1 ? matches[0].email || '' : '', responsible: matches.length === 1 ? matches[0].responsavel || '' : '', registrationId: matches.length === 1 ? matches[0].id : null }
    })
    return { ...closing, rows: validated, contacts }
  }
  const start = () => {
    if (draft?.rows.length && !window.confirm('Descartar este fechamento ainda nao confirmado?')) return
    setDraft({ id: crypto.randomUUID(), period: '', rows: [], contacts: [], subject: '', body: defaultBody('') }); setSavedId(''); setSmart(''); setNotice(''); setError(''); setPage(0)
  }
  const importFiles = async (files: File[]) => {
    if (!draft || lock.current || !manage) return
    lock.current = true; setBusy(true); setError(''); setNotice('')
    try {
      if (!files.length) return
      let candidate = [...draft.rows], skipped = 0
      for (const file of files) {
        if (!/\.csv$/i.test(file.name) || file.size > 8000000) throw new Error('Selecione CSVs de ate 8 MB.')
        const bytes = await file.arrayBuffer()
        let text: string
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { text = new TextDecoder('windows-1252').decode(bytes) }
        const imported = importMaisEnviosCsv(text, draft.period, [...historyRows, ...candidate], postingSmart)
        candidate = [...imported.rows, ...candidate]; skipped += imported.skipped
        if (candidate.length > 20000 || new TextEncoder().encode(JSON.stringify(candidate)).length > 3000000) throw new Error('O fechamento excede 20.000 linhas ou 3 MB.')
      }
      setDraft(withRows(draft, candidate)); setPage(0)
      setNotice(`${candidate.length - draft.rows.length} linhas importadas. ${skipped} etiquetas de postagem repetidas ignoradas.`)
    } catch (failure) { setError(message(failure)) }
    finally { lock.current = false; setBusy(false) }
  }
  const updateRow = (id: string, patch: Partial<MaisEnviosClosingRow>) => {
    if (!draft || busy) return
    setDraft(withRows(draft, draft.rows.map(row => row.id === id ? { ...row, ...patch } : row)))
  }
  const updateContact = (name: string, patch: Partial<MaisEnviosClosingContact>) => {
    setDraft(value => value ? { ...value, contacts: value.contacts.map(contact => maisEnviosSmartKey(contact.smart) === maisEnviosSmartKey(name) ? { ...contact, ...patch } : contact) } : value)
  }
  const confirm = async () => {
    if (!draft || !manage || lock.current || !supabase) return
    lock.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const candidate = withRows(draft, draft.rows)
      assertMaisEnviosClosing(candidate)
      if (!window.confirm(`Confirmar ${candidate.period}? O snapshot, os contatos e o texto do e-mail ficarao preservados. Nenhum e-mail sera enviado agora.`)) return
      const auth = await supabase.auth.getUser()
      if (!auth.data.user || auth.error) throw new Error('Entre novamente no sistema.')
      const result = await supabase.from('mais_envios_closings').insert({ ...candidate, created_by: auth.data.user.id }).select('*').single()
      if (result.error) {
        const recovered = await supabase.from('mais_envios_closings').select('*').eq('id', candidate.id).maybeSingle()
        if (recovered.error || !recovered.data || fingerprint(recovered.data as MaisEnviosClosing) !== fingerprint(candidate)) throw result.error
      }
      setDraft(null); setSavedId(candidate.id); await load(); setNotice('Fechamento confirmado. Nenhum e-mail enviado.')
    } catch (failure) { setError(message(failure)) }
    finally { lock.current = false; setBusy(false) }
  }
  const output = async (action: 'pdf' | 'draft' | 'send', name: string) => {
    if (!current || lock.current) return
    lock.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const contact = current.contacts.find(row => maisEnviosSmartKey(row.smart) === maisEnviosSmartKey(name))
      const filename = `${safeFileName(`${name} - ${current.period}`) || 'fechamento-mais-envios'}.pdf`
      if (action === 'pdf') await createMaisEnviosPdf(current, name).save(filename, { returnPromise: true })
      else {
        if (!contact?.email || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(contact.email)) throw new Error('Confira o e-mail da Smart antes de preparar o envio.')
        if (action === 'draft') { downloadOutlookDraft({ to: contact.email, subject: current.subject, body: current.body, attachmentName: filename, pdf: createMaisEnviosPdf(current, name) }); setNotice('Rascunho baixado com PDF anexo. Nenhum envio realizado pelo aplicativo.') }
        else {
          if (!saved || !manage) throw new Error('Confirme o fechamento antes de enviar.')
          if (!window.confirm(`Enviar o PDF de ${name} para ${contact.email}? Se ja enviou o rascunho manualmente, nao repita o envio aqui.`)) return
          const session = await supabase?.auth.getSession()
          const token = session?.data.session?.access_token
          if (!token) throw new Error('Entre novamente no sistema.')
          const response = await fetch('/api/financial/mais-envios', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ closingId: current.id, smart: name }) })
          if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('API de e-mail indisponivel neste ambiente. Nenhum envio confirmado.')
          const result = await response.json()
          if (!response.ok || result.status !== 'aceito') throw new Error(result.error || 'Envio sem confirmacao. Confira a caixa remetente; nao repita.')
          setMailLogs(value => [...value.filter(row => row.smart_key !== maisEnviosSmartKey(name)), { smart_key: maisEnviosSmartKey(name), status: 'aceito' }])
          setNotice(result.duplicate ? 'O provedor ja havia aceitado este envio. Nenhum novo disparo.' : 'E-mail aceito pelo provedor. A entrega na caixa do destinatario nao e confirmada pelo aplicativo.')
        }
      }
    } catch (failure) { setError(message(failure)) }
    finally { lock.current = false; setBusy(false) }
  }
  const exportAll = async (excel = false) => {
    if (!current || lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      if (excel) {
        const XLSX = await import('xlsx'), workbook = XLSX.utils.book_new()
        const marketplace = current.rows.filter(row => row.kind === 'marketplace').map(row => [row.period, ...row.values.slice(0, 4), row.smart, row.code, row.values[6], row.createdAt, maisEnviosValidityLabel[row.validity]])
        const postings = current.rows.filter(row => row.kind === 'posting').map(row => [row.period, row.code, ...row.values.slice(1, 8), row.valueCents / 100, maisEnviosValidityLabel[row.validity], row.smart])
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([maisEnviosMarketHeaders, ...marketplace]), 'Marketplace')
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([maisEnviosPostingHeaders, ...postings]), 'Postagens')
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Smart', 'Pacotes', 'Objetos Marketplace', 'Postagem paga', '15% Smart', '85% +Envios', 'Resultado', 'Situacao'], ...summaries.map(row => [row.smart, row.packages, row.marketplaceCents / 100, row.postingCents / 100, row.smartShareCents / 100, row.companyShareCents / 100, row.resultCents / 100, row.direction])]), 'Resumo Final')
        XLSX.writeFile(workbook, `${safeFileName(current.period)}-mais-envios.xlsx`)
      } else {
        const zip = new PizZip()
        summaries.forEach((row, index) => zip.file(`${index + 1}-${safeFileName(row.smart)}.pdf`, createMaisEnviosPdf(current, row.smart).output('arraybuffer')))
        const url = URL.createObjectURL(zip.generate({ type: 'blob' })), link = document.createElement('a')
        link.href = url; link.download = `${safeFileName(current.period)}-mais-envios.zip`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
    } catch (failure) { setError(message(failure)) }
    finally { lock.current = false; setBusy(false) }
  }
  if (!view) return <section className="card"><h2>Acesso restrito</h2></section>
  return <section className="mais-envios-finance">
    <header className="mef-heading"><div><p className="eyebrow">FINANCEIRO</p><h1>Mais Envios</h1></div><div className="mef-actions"><button type="button" title="Atualizar fechamentos" aria-label="Atualizar fechamentos" disabled={busy || loading} onClick={() => void load()}><RefreshCw size={18}/></button>{manage && <button type="button" className="primary compact" disabled={busy || loading || loadFailed} onClick={start}><Plus size={18}/> Novo fechamento</button>}</div></header>
    <nav className="mef-tabs" aria-label="Financeiro Mais Envios"><NavLink to={`${BASE}/pagamento-total`}>Pagamento total</NavLink><NavLink to={`${BASE}/pagamento-detalhes`}>Pagamento detalhes</NavLink></nav>
    <div className="mef-toolbar"><label>Fechamento salvo<select aria-label="Fechamento salvo" value={savedId} disabled={busy || loading} onChange={event => {
      if (draft?.rows.length && !window.confirm('Descartar o fechamento ainda nao confirmado?')) return
      setDraft(null); setSavedId(event.target.value); setSmart(''); setPage(0); setError(''); setNotice('')
    }}><option value="">Selecionar</option>{history.map(row => <option key={row.id} value={row.id}>{row.period}</option>)}</select></label>{current && <><span className={`mef-state ${saved ? 'mef-confirmed' : ''}`}>{saved ? 'Confirmado' : `Em revisao - ${pending} pendencia(s)`}</span><button type="button" disabled={busy || !current.rows.length} onClick={() => void exportAll(true)}><Download size={17}/> Excel</button><button type="button" disabled={busy || !summaries.length || pending > 0} onClick={() => void exportAll()}><FileDown size={17}/> PDFs (ZIP)</button></>}</div>
    {loading && <p role="status">Carregando fechamentos...</p>}{error && <p className="mef-error" role="alert">{error}</p>}{notice && <p className="mef-notice" role="status">{notice}</p>}
    {!loading && !current && !loadFailed && <p className="mef-empty">Nenhum fechamento selecionado.</p>}
    {draft && <section className="mef-import"><label>Periodo<input aria-label="Periodo Mais Envios" maxLength={100} value={draft.period} disabled={busy || draft.rows.length > 0} onChange={event => { const period = event.target.value; setDraft({ ...draft, period, subject: `Fechamento Mais Envios - ${period}`, body: defaultBody(period) }) }}/></label><label>Smart das postagens<input aria-label="Smart das postagens" list="mef-smarts" maxLength={200} value={postingSmart} disabled={busy} onChange={event => setPostingSmart(event.target.value)}/></label><label className={`mef-upload ${busy || !draft.period.trim() ? 'mef-disabled' : ''}`}><Upload size={18}/> Importar CSVs<input aria-label="Importar CSVs Mais Envios" type="file" accept=".csv,text/csv" multiple disabled={busy || !draft.period.trim()} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void importFiles(files) }}/></label><button type="button" className="primary compact" disabled={busy || pending > 0 || !draft.rows.length} onClick={() => void confirm()}><Save size={18}/> Confirmar fechamento</button></section>}
    <datalist id="mef-smarts">{smartNames.map(name => <option key={name} value={name}/>)}</datalist>
    {current && <>
      {!details ? <div className="mef-table-scroll"><table><thead><tr>{['Smart', 'Pacotes', 'Objetos Marketplace', 'Postagem paga', '15% Smart', '85% +Envios', 'Resultado', 'Situacao', 'Documentos'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{summaries.map(row => {
        const log = mailLogs.find(item => item.smart_key === maisEnviosSmartKey(row.smart))
        const unresolved = current.rows.some(item => maisEnviosSmartKey(item.smart) === maisEnviosSmartKey(row.smart) && item.validity === 'pending')
        return <tr key={row.smart}><th scope="row">{row.smart}</th><td>{row.packages}</td>{[row.marketplaceCents, row.postingCents, row.smartShareCents, row.companyShareCents, row.resultCents].map((value, index) => <td className="mef-number" key={index}>{maisEnviosMoney(value)}</td>)}<td>{row.direction}{log && <small>{log.status === 'aceito' ? 'E-mail aceito pelo provedor' : 'Envio sem confirmacao'}</small>}</td><td><div className="mef-actions"><button type="button" title={`PDF ${row.smart}`} aria-label={`PDF ${row.smart}`} disabled={busy || unresolved} onClick={() => void output('pdf', row.smart)}><FileDown size={17}/></button><button type="button" title={`Rascunho ${row.smart}`} aria-label={`Rascunho ${row.smart}`} disabled={busy || unresolved || !manage} onClick={() => void output('draft', row.smart)}><Mail size={17}/></button>{saved && manage && <button type="button" title={`Enviar e-mail ${row.smart}`} aria-label={`Enviar e-mail ${row.smart}`} disabled={busy || Boolean(log)} onClick={() => void output('send', row.smart)}><Send size={17}/></button>}</div></td></tr>
      })}</tbody></table></div> : <>
        <div className="mef-toolbar"><label>Tipo<select aria-label="Tipo" value={kind} onChange={event => { setKind(event.target.value as typeof kind); setPage(0) }}><option value="marketplace">Objetos Marketplace</option><option value="posting">Postagens pagas</option></select></label><label>Smart<select aria-label="Smart" value={smart} onChange={event => { setSmart(event.target.value); setPage(0) }}><option value="">Todas</option>{smartNames.map(name => <option key={name}>{name}</option>)}</select></label><label>Validacao<select aria-label="Validacao" value={validity} onChange={event => { setValidity(event.target.value); setPage(0) }}><option value="">Todas</option>{Object.entries(maisEnviosValidityLabel).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div>
        <div className="mef-table-scroll"><table><thead><tr>{(kind === 'marketplace' ? maisEnviosMarketHeaders : maisEnviosPostingHeaders).map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{visible.slice(actualPage * 50, (actualPage + 1) * 50).map(row => {
          const automatic = row.kind === 'marketplace' ? maisEnviosCodeValidity(row.code) : maisEnviosPostingValidity(row.values[1])
          const cells = row.kind === 'marketplace' ? [row.period, ...row.values.slice(0, 4), row.smart, row.code, row.values[6], row.createdAt, maisEnviosValidityLabel[row.validity]] : [row.period, row.code, ...row.values.slice(1, 8), maisEnviosMoney(row.valueCents), maisEnviosValidityLabel[row.validity], row.smart]
          const smartColumn = row.kind === 'marketplace' ? 5 : 11, codeColumn = row.kind === 'marketplace' ? 6 : 1, validityColumn = row.kind === 'marketplace' ? 9 : 10
          return <tr key={row.id} className={row.validity === 'pending' || !row.smart.trim() ? 'mef-pending-row' : ''}>{cells.map((value, index) => <td key={index}>{!saved && manage && index === smartColumn ? <input aria-label={`Smart ${row.id}`} list="mef-smarts" value={row.smart} disabled={busy} maxLength={200} onChange={event => updateRow(row.id, { smart: event.target.value })}/> : !saved && manage && row.kind === 'marketplace' && index === codeColumn ? <input aria-label={`Codigo ${row.id}`} title={`Original: ${row.originalCode}`} value={row.code} disabled={busy} maxLength={2000} onChange={event => updateRow(row.id, { code: event.target.value, manual: null })}/> : !saved && manage && index === validityColumn ? <select aria-label={`Validacao ${row.id}`} value={row.validity} disabled={busy || automatic !== 'pending' || row.validity === 'duplicate'} onChange={event => updateRow(row.id, { manual: event.target.value === 'pending' ? null : event.target.value as 'valid' | 'invalid' })}>{Object.entries(maisEnviosValidityLabel).map(([key, label]) => <option value={key} key={key} disabled={key === 'duplicate'}>{label}</option>)}</select> : value || '-'}</td>)}</tr>
        })}</tbody></table></div><div className="mef-pagination"><span>{visible.length} linha(s) - Pagina {actualPage + 1} de {pages}</span><button type="button" disabled={actualPage === 0} onClick={() => setPage(actualPage - 1)}>Anterior</button><button type="button" disabled={actualPage + 1 >= pages} onClick={() => setPage(actualPage + 1)}>Proxima</button></div>
      </>}
      <details className="mef-email" open={!saved}><summary>Contatos e e-mail do fechamento</summary><div className="mef-contact-grid">{current.contacts.map(contact => <fieldset key={contact.smart}><legend>{contact.smart}</legend>{!saved && registrations.length > 0 && <label>Cadastro<select aria-label={`Cadastro ${contact.smart}`} value={contact.registrationId ?? ''} disabled={busy} onChange={event => { const registration = registrations.find(row => row.id === event.target.value); updateContact(contact.smart, { registrationId: registration?.id ?? null, email: registration?.email ?? '', responsible: registration?.responsavel ?? '' }) }}><option value="">Contato manual</option>{registrations.map(registration => <option key={registration.id} value={registration.id}>{registration.smart}</option>)}</select></label>}<label>Responsavel<input aria-label={`Responsavel ${contact.smart}`} value={contact.responsible} disabled={saved || busy || !manage} maxLength={200} onChange={event => updateContact(contact.smart, { responsible: event.target.value })}/></label><label>E-mail<input aria-label={`E-mail ${contact.smart}`} type="email" value={contact.email} disabled={saved || busy || !manage} maxLength={254} onChange={event => updateContact(contact.smart, { email: event.target.value, registrationId: null })}/></label></fieldset>)}</div><label>Assunto<input aria-label="Assunto Mais Envios" value={current.subject} maxLength={200} disabled={saved || busy || !manage} onChange={event => setDraft(value => value ? { ...value, subject: event.target.value } : value)}/></label><label>Texto<textarea aria-label="Texto Mais Envios" value={current.body} maxLength={30000} disabled={saved || busy || !manage} onChange={event => setDraft(value => value ? { ...value, body: event.target.value } : value)}/></label></details>
    </>}
  </section>
}