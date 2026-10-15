import { ChangeEvent, useEffect, useRef, useState } from 'react'
import { supabase } from './lib/supabase'
import { useAccess } from './access'

export default function ContractTemplateManager() {
  return <><TemplateEditor kind="service" /><TemplateEditor kind="termination" /></>
}

function TemplateEditor({kind}:{kind:'service'|'termination'}) {
  const original=kind==='service'?'/templates/modelo-contrato-prestacao-servico.docx':'/templates/modelo-distrato-sociedade.docx'
  const field=kind==='service'?'serviceTemplatePath':'terminationTemplatePath'
  const label=kind==='service'?'contrato':'distrato'
  const { isAdmin } = useAccess()
  const [path, setPath] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const token = async () => { const result = await supabase?.auth.getSession(); return result?.data.session?.access_token ?? '' }
  const load = async () => {
    setLoading(true); setLoadError(false); setMessage('')
    try {
      const accessToken = await token()
      const response = await fetch('/api/contract-templates', { headers: { Authorization: `Bearer ${accessToken}` } })
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Não foi possível consultar o modelo ativo.')
      const data = await response.json()
      setPath(data[field] ?? '')
    } catch (error) { setLoadError(true); setMessage(error instanceof Error ? error.message : 'Não foi possível consultar o modelo ativo.') }
    finally { setLoading(false) }
  }
  useEffect(() => { if (isAdmin) void load() }, [isAdmin])
  if (!isAdmin) return null

  const setActive = async (serviceTemplatePath: string) => {
    const accessToken = await token()
    const response = await fetch('/api/contract-templates', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ [field]:serviceTemplatePath }) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? 'Não foi possível atualizar o modelo.')
    setPath(data[field] ?? '')
  }
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !supabase || busy || loading || loadError) return
    if (!file.name.toLowerCase().endsWith('.docx')) return setMessage('Envie um arquivo .docx.')
    if(file.size>5*1024*1024)return setMessage('O modelo deve ter no máximo 5 MB.')
    setBusy(true); setMessage('Enviando modelo atualizado...')
    try {
      const safeName = file.name.replace(/[^a-z0-9._-]/gi, '_')
      const {default:PizZip}=await import('pizzip')
      if(!new PizZip(await file.arrayBuffer()).file('word/document.xml'))throw new Error('Arquivo DOCX inválido.')
      const storagePath = `contract-templates/${kind}/${crypto.randomUUID()}-${safeName}`
      const { error } = await supabase.storage.from('movidos-documents').upload(storagePath, file, { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
      if (error) throw error
      await setActive(storagePath)
      setMessage(`Modelo de ${label} ativado para os próximos documentos.`)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Não foi possível enviar o modelo.') }
    finally { setBusy(false) }
  }
  const restore = async () => {
    setBusy(true)
    try { await setActive(''); setMessage('Modelo padrão restaurado para os próximos contratos.') }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Não foi possível restaurar o modelo.') }
    finally { setBusy(false) }
  }

  const download = async () => {
    if (busy || loading || loadError || !supabase) return
    setBusy(true); setMessage('')
    try {
      let file: Blob
      if (path) {
        const { data, error } = await supabase.storage.from('movidos-documents').download(path)
        if (error || !data) throw new Error('Não foi possível baixar o modelo ativo.')
        file = data
      } else {
        const response = await fetch(original)
        if (!response.ok) throw new Error('Não foi possível baixar o modelo padrão.')
        file = await response.blob()
      }
      const url = URL.createObjectURL(file)
      const link = document.createElement('a')
      link.href = url; link.download = `modelo-${label}-atual.docx`; link.click(); URL.revokeObjectURL(url)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Não foi possível baixar o modelo.') }
    finally { setBusy(false) }
  }

  return <section className="form-section document-actions template-editor" aria-label={`Modelo de ${label}`}>
    <h3>Modelo do {label} - administração</h3>
    <p>{loading ? 'Consultando modelo...' : loadError ? 'Modelo indisponível.' : path ? 'Modelo personalizado ativo.' : 'Modelo padrão ativo.'}</p>
    <div>
      <button type="button" className="secondary" disabled={busy || loading || loadError} onClick={() => void download()}>Baixar modelo atual (Word)</button>
      <button type="button" className="secondary" disabled={busy || loading || loadError} onClick={() => input.current?.click()}>Enviar modelo atualizado</button>
      <input ref={input} aria-label={`Alterar modelo do ${label}`} type="file" accept=".docx" onChange={upload} disabled={busy || loading || loadError} hidden />
      {path && !loading && !loadError && <a className="secondary" href={original} download>Baixar modelo original (Word)</a>}
      {path && !loadError && <button type="button" className="secondary" disabled={busy || loading} onClick={() => void restore()}>Restaurar modelo padrão{kind==='termination'?' do distrato':''}</button>}
      {loadError && <button type="button" className="secondary" disabled={loading} onClick={() => void load()}>Tentar novamente</button>}
    </div>
    {message && <p role="status" className="form-message">{message}</p>}
  </section>
}
