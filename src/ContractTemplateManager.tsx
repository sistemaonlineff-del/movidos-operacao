import { ChangeEvent, useEffect, useState } from 'react'
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

  const token = async () => { const result = await supabase?.auth.getSession(); return result?.data.session?.access_token ?? '' }
  const load = async () => {
    const accessToken = await token()
    const response = await fetch('/api/contract-templates', { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return
    const data = await response.json()
    setPath(data[field] ?? '')
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
    if (!file || !supabase) return
    if (!file.name.toLowerCase().endsWith('.docx')) return setMessage('Envie um arquivo .docx.')
    if(file.size>5*1024*1024)return setMessage('O modelo deve ter no máximo 5 MB.')
    setBusy(true); setMessage('Enviando modelo temporário...')
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

  return <section className="form-section document-actions" aria-label={`Modelo de ${label}`}><h3>Modelo do {label} - administração</h3><p>{path ? 'Modelo personalizado ativo.' : 'Modelo padrão ativo.'}</p><div><a className="secondary" href={original} download>Baixar modelo padrão {kind==='termination'?'do distrato ':''}para editar</a><label className={`secondary ${busy ? 'disabled' : ''}`}>Enviar modelo temporário{kind==='termination'?' do distrato':''}<input aria-label={`Alterar modelo do ${label}`} type="file" accept=".docx" onChange={upload} disabled={busy} hidden /></label>{path && <button type="button" className="secondary" disabled={busy} onClick={() => void restore()}>Restaurar modelo padrão{kind==='termination'?' do distrato':''}</button>}</div>{message && <p role="status" className="form-message">{message}</p>}</section>
}
