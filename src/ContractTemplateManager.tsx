import { ChangeEvent, useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { useAccess } from './access'

const original = '/templates/modelo-contrato-prestacao-servico.docx'

export default function ContractTemplateManager() {
  const { isAdmin } = useAccess()
  const [path, setPath] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const token = async () => { const result = await supabase?.auth.getSession(); return result?.data.session?.access_token ?? '' }
  const load = async () => {
    const accessToken = await token()
    const response = await fetch('/api/contract-templates', { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!response.ok) return
    const data = await response.json()
    setPath(data.serviceTemplatePath ?? '')
  }
  useEffect(() => { if (isAdmin) void load() }, [isAdmin])
  if (!isAdmin) return null

  const setActive = async (serviceTemplatePath: string) => {
    const accessToken = await token()
    const response = await fetch('/api/contract-templates', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ serviceTemplatePath }) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? 'Não foi possível atualizar o modelo.')
    setPath(data.serviceTemplatePath ?? '')
  }
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !supabase) return
    if (!file.name.toLowerCase().endsWith('.docx')) return setMessage('Envie um arquivo .docx.')
    setBusy(true); setMessage('Enviando modelo temporário...')
    try {
      const safeName = file.name.replace(/[^a-z0-9._-]/gi, '_')
      const storagePath = `contract-templates/service/${Date.now()}-${safeName}`
      const { error } = await supabase.storage.from('movidos-documents').upload(storagePath, file, { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
      if (error) throw error
      await setActive(storagePath)
      setMessage('Modelo temporário ativado. Os próximos contratos usarão esta versão.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Não foi possível enviar o modelo.') }
    finally { setBusy(false) }
  }
  const restore = async () => {
    setBusy(true)
    try { await setActive(''); setMessage('Modelo padrão restaurado para os próximos contratos.') }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Não foi possível restaurar o modelo.') }
    finally { setBusy(false) }
  }

  return <section className="form-section document-actions"><h3>Modelo do contrato — administração</h3><p>{path ? 'Há um modelo temporário ativo.' : 'O modelo padrão está ativo.'} Contratos já gerados não são alterados.</p><div><a className="secondary" href={original} download>Baixar modelo padrão para editar</a><label className={`secondary ${busy ? 'disabled' : ''}`}>Enviar modelo temporário<input type="file" accept=".docx" onChange={upload} disabled={busy} hidden /></label>{path && <button type="button" className="secondary" disabled={busy} onClick={() => void restore()}>Restaurar modelo padrão</button>}</div>{message && <p className="form-message">{message}</p>}</section>
}
