import { ChangeEvent, useEffect, useRef, useState } from 'react'
import { supabase } from './lib/supabase'

type Kind = 'contrato' | 'distrato'
type StoredDocument = { id: string; kind: Kind; file_name: string; storage_path: string }
const bucket = 'movidos-documents'
const labels: Record<Kind, string> = { contrato: 'Contratos', distrato: 'Distratos' }

export default function DropDocuments({ dropId }: { dropId: string | null }) {
  const [documents, setDocuments] = useState<StoredDocument[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const contractInput = useRef<HTMLInputElement>(null)
  const terminationInput = useRef<HTMLInputElement>(null)
  const inputFor = (kind: Kind) => kind === 'contrato' ? contractInput : terminationInput

  const load = async () => {
    if (!supabase || !dropId) return
    const { data, error } = await supabase.from('drop_documents').select('id,kind,file_name,storage_path').eq('drop_id', dropId).in('kind', ['contrato', 'distrato']).eq('is_active', true).order('created_at', { ascending: false })
    if (error) { setMessage(error.message); return }
    setDocuments((data ?? []) as StoredDocument[])
  }
  useEffect(() => { setDocuments([]); setMessage(''); void load() }, [dropId])

  const upload = async (kind: Kind, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!supabase || !dropId || !file) return
    if (file.size > 15 * 1024 * 1024) { setMessage('O arquivo deve ter no máximo 15 MB.'); return }
    setBusy(true); setMessage('')
    const safeName = file.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._-]/g, '-')
    const path = `drops/${dropId}/${kind}s/${crypto.randomUUID()}-${safeName}`
    const { error: uploadError } = await supabase.storage.from(bucket).upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false })
    if (uploadError) setMessage(uploadError.message)
    else {
      const { data: auth } = await supabase.auth.getUser()
      const { error } = await supabase.from('drop_documents').insert({ drop_id: dropId, kind, file_name: file.name, storage_path: path, mime_type: file.type || null, uploaded_by: auth.user?.id ?? null })
      if (error) { await supabase.storage.from(bucket).remove([path]); setMessage(error.message) }
    }
    const input = inputFor(kind)
    if (input.current) input.current.value = ''
    setBusy(false); await load()
  }
  const download = async (item: StoredDocument) => {
    if (!supabase) return
    const { data, error } = await supabase.storage.from(bucket).download(item.storage_path)
    if (error) { setMessage(error.message); return }
    const url = URL.createObjectURL(data); const link = window.document.createElement('a'); link.href = url; link.download = item.file_name; link.click(); URL.revokeObjectURL(url)
  }

  return <section className="form-section drop-documents">
    <h3>Contratos e distratos</h3>
    {!dropId ? <p className="financial-hint">Salve o cadastro primeiro para anexar contratos e distratos.</p> : <>
      <p className="financial-hint">Anexe PDF, Word ou imagem de até 15 MB.</p>
      <div className="document-upload-grid">{(['contrato', 'distrato'] as Kind[]).map(kind => <article className="document-upload" key={kind}><strong>{labels[kind]}</strong><label className={`secondary ${busy ? 'disabled' : ''}`}>Anexar {kind}<input ref={inputFor(kind)} type="file" accept=".pdf,.doc,.docx,image/jpeg,image/png,image/webp" disabled={busy} onChange={event => void upload(kind, event)} hidden /></label><div>{documents.filter(item => item.kind === kind).map(item => <button type="button" className="table-action" key={item.id} onClick={() => void download(item)} title={item.file_name}>{item.file_name}</button>)}{!documents.some(item => item.kind === kind) && <span className="empty-inline">Nenhum anexo.</span>}</div></article>)}</div>
    </>}
    {busy && <p className="form-message" role="status">Enviando documento…</p>}
    {message && <p className="error" role="alert">{message}</p>}
  </section>
}
