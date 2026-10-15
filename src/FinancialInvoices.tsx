import { useEffect, useRef, useState } from 'react'
import { useAccess } from './access'
import { buildDetails, type DataRow, financialPartner, key } from './financialData'
import { readFinancialRows } from './financialStore'
import { supabase } from './lib/supabase'
import './invoices.css'

type InvoiceFile = { id: string; file_name: string; status: string; received_at: string | null }
type InvoiceRequest = { id: string; financial_period_id: string; drop_id: string; drop_name: string; period_label: string; partner: string; reference_cnpj: string; expires_at: string; revoked_at: string | null; financial_invoice_files: InvoiceFile[] }
type InvoiceInfo = { drop: string; period: string; partner: string; referenceCnpj: string; expiresAt: string; files: Pick<InvoiceFile, 'file_name' | 'received_at'>[] }

async function callInvoices(body?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['X-Invoice-Token'] = token
  else {
    const session = await supabase?.auth.getSession()
    if (!session?.data.session) throw new Error('Entre novamente no sistema.')
    headers.Authorization = `Bearer ${session.data.session.access_token}`
  }
  const response = await fetch('/api/financial/invoices', { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}), referrerPolicy: 'no-referrer', cache: 'no-store' })
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('API de notas fiscais indisponível. Confira a implantação do servidor.')
  const data = await response.json()
  if (!response.ok || response.status === 202) throw new Error(data.error || 'Não foi possível confirmar a operação.')
  return data
}

export function InvoiceUpload() {
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') || '')
  const [info, setInfo] = useState<InvoiceInfo | null>(null)
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null), running = useRef(false)
  useEffect(() => {
    let current = true
    if (!token) { setError('Link inválido. Solicite um novo ao financeiro.'); return }
    void callInvoices(undefined, token).then(data => { if (current) setInfo(data) }).catch(caught => { if (current) setError(caught.message) })
    return () => { current = false }
  }, [token])
  const send = async () => {
    const file = input.current?.files?.[0]
    if (!file || running.current) return
    setError(''); setMessage('')
    if (file.size > 3145728 || !/\.(pdf|xml)$/i.test(file.name)) { setError('Selecione PDF ou XML de até 3 MB.'); return }
    running.current = true; setBusy(true)
    try {
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1])
        reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'))
        reader.readAsDataURL(file)
      })
      const result = await callInvoices({ mode: 'upload', clientUploadId: crypto.randomUUID(), fileName: file.name, content }, token)
      setMessage(result.duplicate ? 'Esta nota já foi recebida. Nenhuma cópia foi criada.' : 'Nota fiscal recebida e salva.')
      if (input.current) input.current.value = ''
      setInfo(await callInvoices(undefined, token))
    } catch (caught) { setError((caught as Error).message) }
    finally { running.current = false; setBusy(false) }
  }
  return <main className="invoice-public"><img src="/brand/movidos-fish.png" alt="Movidos" /><h1>Envio de nota fiscal</h1>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {!info && !error && <p role="status">Carregando solicitação...</p>}
    {info && <><h2>{info.drop}</h2><dl className="invoice-scope"><div><dt>Quinzena</dt><dd>{info.period}</dd></div><div><dt>Parceiro</dt><dd>{info.partner}</dd></div><div><dt>CNPJ de referência</dt><dd>{info.referenceCnpj}</dd></div><div><dt>Validade do link</dt><dd>{new Date(info.expiresAt).toLocaleDateString('pt-BR')}</dd></div></dl>
      <form onSubmit={event => { event.preventDefault(); void send() }}><label>Nota fiscal (PDF ou XML, até 3 MB)<input type="file" ref={input} accept=".pdf,.xml,application/pdf,application/xml,text/xml" required disabled={busy} /></label><button type="submit" disabled={busy}>{busy ? 'Enviando...' : 'Enviar nota fiscal'}</button></form>
      <h2>Notas recebidas ({info.files.length})</h2>{info.files.length ? <ul>{info.files.map((file, index) => <li key={`${file.file_name}-${index}`}>{file.file_name} <small>{file.received_at ? new Date(file.received_at).toLocaleString('pt-BR') : ''}</small></li>)}</ul> : <p>Nenhuma nota recebida.</p>}
    </>}
  </main>
}

export default function FinancialInvoices() {
  const { can } = useAccess()
  const [rows, setRows] = useState<DataRow[]>([]), [requests, setRequests] = useState<InvoiceRequest[]>([])
  const [period, setPeriod] = useState(''), [partner, setPartner] = useState(''), [reference, setReference] = useState(''), [status, setStatus] = useState('')
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const [link, setLink] = useState(''), [linkScope, setLinkScope] = useState('')
  const running = useRef(false)
  const load = async () => {
    setLoading(true); setError('')
    try {
      const [periods, history, items, drops, response] = await Promise.all([
        readFinancialRows('financial_periods'), readFinancialRows('financial_payment_history'), readFinancialRows('financial_drop_items'), readFinancialRows('invoice_drops'), callInvoices(),
      ])
      const details = buildDetails(history, items, [], periods, drops)
      const unique = new Map<string, DataRow>()
      for (const row of details) {
        const parent = periods.find(item => item.id === row.periodId)
        const matchingDrops = drops.filter(drop => key(drop.name) === key(row.drop) && financialPartner(drop) === row.partner)
        const dropId = row.dropId || (!row.registrationSnapshot?.version && matchingDrops.length === 1 ? matchingDrops[0].id : null)
        unique.set(`${row.periodId}|${dropId || key(row.drop)}|${row.referenceCnpj}`, { ...row, dropId, scopeValid: Boolean(parent && (parent.reference_cnpj || 'MOVIDOS') === row.referenceCnpj) })
      }
      setRows([...unique.values()]); setRequests(response.requests)
    } catch (caught) { setError((caught as Error).message) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  const findRequest = (row: DataRow) => requests.find(request => request.financial_period_id === row.periodId && request.drop_id === row.dropId)
  const filesFor = (row: DataRow) => findRequest(row)?.financial_invoice_files.filter(file => file.status === 'received') || []
  const visible = rows.filter(row => (!period || row.period === period) && (!partner || row.partner === partner) && (!reference || row.referenceCnpj === reference) && (!status || (filesFor(row).length ? 'received' : 'pending') === status))
  const options = (field: string) => [...new Set(rows.map(row => String(row[field] || '')).filter(Boolean))].sort((first, second) => first.localeCompare(second, 'pt-BR', { numeric: true }))
  const act = async (action: () => Promise<void>) => {
    if (running.current) return
    running.current = true; setBusy(true); setError(''); setMessage('')
    try { await action() } catch (caught) { setError((caught as Error).message) }
    finally { running.current = false; setBusy(false) }
  }
  const createLink = (row: DataRow) => void act(async () => {
    if (findRequest(row) && !window.confirm('Gerar novo link invalida o anterior. As notas já recebidas serão mantidas. Continuar?')) return
    const result = await callInvoices({ mode: 'create', periodId: row.periodId, dropId: row.dropId })
    setLink(`${window.location.origin}/enviar-nf#token=${result.token}`)
    setLinkScope(`${row.drop} · ${row.responsible} · ${row.period} · ${row.partner} · ${row.referenceCnpj}`)
    await load()
  })
  return <section className="invoice-management"><header><h1>Notas fiscais dos DROPs</h1><button type="button" disabled={busy || loading} onClick={() => void load()}>Atualizar</button></header>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <div className="invoice-filters"><label>Quinzena<select aria-label="Quinzena" value={period} onChange={event => setPeriod(event.target.value)}><option value="">Todas</option>{options('period').map(value => <option key={value}>{value}</option>)}</select></label><label>Parceiro<select aria-label="Parceiro" value={partner} onChange={event => setPartner(event.target.value)}><option value="">Todos</option>{options('partner').map(value => <option key={value}>{value}</option>)}</select></label><label>CNPJ de referência<select aria-label="CNPJ de referência" value={reference} onChange={event => setReference(event.target.value)}><option value="">Todas as empresas</option>{options('referenceCnpj').map(value => <option key={value}>{value}</option>)}</select></label><label>Recebimento<select aria-label="Recebimento" value={status} onChange={event => setStatus(event.target.value)}><option value="">Todos</option><option value="pending">Pendente</option><option value="received">Recebida</option></select></label></div>
    {link && <div className="invoice-link" role="region" aria-label="Link de envio"><strong>{linkScope}</strong><label>Link individual<input readOnly value={link} onFocus={event => event.target.select()} /></label><button type="button" onClick={() => void act(async () => { await navigator.clipboard.writeText(link); setMessage('Link copiado.') })}>Copiar link</button><button type="button" onClick={() => setLink('')}>Fechar link</button></div>}
    {loading ? <p role="status">Carregando notas fiscais...</p> : <><p>{visible.filter(row => filesFor(row).length).length} recebidas · {visible.filter(row => !filesFor(row).length).length} pendentes</p><div className="invoice-table"><table><thead><tr><th>Quinzena</th><th>Parceiro</th><th>CNPJ de referência</th><th>DROP</th><th>Responsável</th><th>NF</th><th>Arquivos</th><th>Link</th></tr></thead><tbody>{visible.map(row => {
      const request = findRequest(row), files = filesFor(row)
      const linkActive = request && !request.revoked_at && Date.parse(request.expires_at) > Date.now()
      return <tr key={`${row.periodId}-${row.dropId || row.drop}-${row.referenceCnpj}`}><td>{row.period}</td><td>{row.partner}</td><td>{row.referenceCnpj}</td><td>{row.drop}</td><td>{row.responsible}</td><td>{files.length ? 'Recebida' : 'Pendente'}</td><td>{files.map(file => <button key={file.id} type="button" disabled={busy} onClick={() => void act(async () => { const result = await callInvoices({ mode: 'download', fileId: file.id }); window.location.assign(result.url) })}>{file.file_name}</button>)}</td><td>{!row.dropId ? 'Cadastro não vinculado' : !row.scopeValid ? 'Revisar CNPJ do período' : <>{request && <small>{linkActive ? 'Link ativo' : 'Link expirado ou revogado'}</small>}{can('financeiro_manage') && <><button type="button" disabled={busy} onClick={() => createLink(row)}>{request ? 'Renovar link' : 'Gerar link'}</button>{linkActive && <button type="button" disabled={busy} onClick={() => void act(async () => { if (!window.confirm('Revogar este link? As notas recebidas serão mantidas.')) return; await callInvoices({ mode: 'revoke', requestId: request.id }); setLink(''); await load(); setMessage('Link revogado.') })}>Revogar</button>}</>}</>}</td></tr>
    })}{!visible.length && <tr><td colSpan={8}>Nenhum DROP neste filtro.</td></tr>}</tbody></table></div></>}
    {requests.some(request=>request.financial_invoice_files.some(file=>file.status!=='received'))&&<section className="invoice-reconciliation"><h2>Envios sem confirmação</h2>{requests.flatMap(request=>request.financial_invoice_files.filter(file=>file.status!=='received').map(file=><div key={file.id}><span>{request.drop_name} · {request.period_label} · {request.partner} · {request.reference_cnpj} · {file.file_name}</span>{can('financeiro_manage')&&<button disabled={busy} onClick={()=>void act(async()=>{await callInvoices({mode:'reconcile',fileId:file.id});await load();setMessage('Arquivo conferido e recebimento confirmado.')})}>Conferir armazenamento</button>}</div>))}</section>}
    {requests.some(request=>!rows.some(row=>row.periodId===request.financial_period_id&&row.dropId===request.drop_id))&&<details className="invoice-archive"><summary>Notas fora da base ativa</summary>{requests.filter(request=>!rows.some(row=>row.periodId===request.financial_period_id&&row.dropId===request.drop_id)).map(request=><section key={request.id}><h3>{request.drop_name} · {request.period_label} · {request.partner} · {request.reference_cnpj}</h3>{request.financial_invoice_files.filter(file=>file.status==='received').map(file=><button key={file.id} disabled={busy} onClick={()=>void act(async()=>{const result=await callInvoices({mode:'download',fileId:file.id});window.location.assign(result.url)})}>{file.file_name}</button>)}</section>)}</details>}
  </section>
}