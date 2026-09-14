import { ChangeEvent, useEffect, useRef, useState } from 'react'
import { supabase } from './lib/supabase'

type Photo = { id: string; file_name: string; storage_path: string; mime_type: string | null; created_at: string; url?: string }
const bucket = 'movidos-documents'

export default function DropPhotos({ dropId }: { dropId: string | null }) {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const input = useRef<HTMLInputElement>(null)

  const load = async () => {
    const client = supabase
    if (!client || !dropId) return
    const { data, error } = await client.from('drop_documents').select('id,file_name,storage_path,mime_type,created_at').eq('drop_id', dropId).eq('kind', 'foto').eq('is_active', true).order('created_at', { ascending: false })
    if (error) { setMessage(error.message); return }
    const rows = await Promise.all((data ?? []).map(async photo => {
      const { data: signed } = await client.storage.from(bucket).createSignedUrl(photo.storage_path, 3600)
      return { ...photo, url: signed?.signedUrl } as Photo
    }))
    setPhotos(rows)
  }
  useEffect(() => { setPhotos([]); setMessage(''); void load() }, [dropId])

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])]
    if (!supabase || !dropId || !files.length) return
    const invalid = files.find(file => !file.type.startsWith('image/') || file.size > 10 * 1024 * 1024)
    if (invalid) { setMessage('Envie somente imagens de até 10 MB cada.'); return }
    setBusy(true); setMessage('')
    const { data: auth } = await supabase.auth.getUser()
    for (const file of files) {
      const safeName = file.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._-]/g, '-')
      const path = `drops/${dropId}/fotos/${crypto.randomUUID()}-${safeName}`
      const uploaded = await supabase.storage.from(bucket).upload(path, file, { contentType: file.type, upsert: false })
      if (uploaded.error) { setMessage(uploaded.error.message); break }
      const saved = await supabase.from('drop_documents').insert({ drop_id: dropId, kind: 'foto', file_name: file.name, storage_path: path, mime_type: file.type, uploaded_by: auth.user?.id ?? null })
      if (saved.error) { await supabase.storage.from(bucket).remove([path]); setMessage(saved.error.message); break }
    }
    if (input.current) input.current.value = ''
    setBusy(false); await load()
  }

  const download = async (photo: Photo) => {
    if (!supabase) return
    const { data, error } = await supabase.storage.from(bucket).download(photo.storage_path)
    if (error) { setMessage(error.message); return }
    const url = URL.createObjectURL(data)
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = photo.file_name; anchor.click()
    URL.revokeObjectURL(url)
  }
  const remove = async (photo: Photo) => {
    if (!supabase) return
    const reason = window.prompt(`Informe obrigatoriamente o motivo para remover a foto ${photo.file_name}:`)?.trim()
    if (!reason) { setMessage('A observação é obrigatória. A foto não foi removida.'); return }
    setBusy(true); setMessage('')
    const { data: auth } = await supabase.auth.getUser()
    const { error } = await supabase.from('drop_documents').update({ is_active: false, deactivated_reason: reason, deactivated_at: new Date().toISOString(), deactivated_by: auth.user?.id ?? null }).eq('id', photo.id)
    if (error) setMessage(error.message)
    setBusy(false); await load()
  }

  return <section className="form-section drop-photos">
    <h3>Fotos do ponto</h3>
    {!dropId ? <p className="financial-hint">Salve o cadastro primeiro. Depois abra-o para anexar as fotos da fachada e do espaço interno.</p> : <>
      <label className="photo-upload">Anexar fotos<input ref={input} aria-label="Anexar fotos" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy} onChange={event => void upload(event)} /></label>
      <p className="financial-hint">JPG, PNG ou WEBP. Até 10 MB por foto.</p>
      <div className="photo-grid">{photos.map(photo => <article key={photo.id} className="photo-card">
        {photo.url ? <img src={photo.url} alt={photo.file_name} /> : <div className="photo-placeholder">FOTO</div>}
        <strong title={photo.file_name}>{photo.file_name}</strong>
        <div><button type="button" className="secondary" onClick={() => void download(photo)}>Baixar</button><button type="button" className="danger" disabled={busy} onClick={() => void remove(photo)}>Desativar</button></div>
      </article>)}</div>
      {!photos.length && !busy && <p className="empty-inline">Nenhuma foto anexada.</p>}
    </>}
    {busy && <p role="status" className="form-message">Enviando fotos…</p>}
    {message && <p role="alert" className="error">{message}</p>}
  </section>
}
