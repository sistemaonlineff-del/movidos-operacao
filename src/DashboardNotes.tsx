import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { useAccess } from './access'

type NoteKey = 'general' | 'financial'
const definitions: Array<{ key: NoteKey; title: string }> = [
  { key: 'general', title: 'Anotações gerais' },
  { key: 'financial', title: 'Anotações do financeiro' },
]

export default function DashboardNotes({ financialOnly = false }: { financialOnly?: boolean }) {
  const { can } = useAccess()
  const [notes, setNotes] = useState<Record<NoteKey, string>>({ general: '', financial: '' })
  const [saving, setSaving] = useState<NoteKey | null>(null)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let current = true
    if (!supabase) return
    supabase.from('app_notes').select('key,content').then(({ data, error }) => {
      if (!current) return
      if (error) { setMessage(error.message); return }
      setNotes(value => ({ ...value, ...Object.fromEntries((data ?? []).map(row => [row.key, row.content ?? ''])) }))
    })
    return () => { current = false }
  }, [])

  const save = async (key: NoteKey) => {
    if (!supabase || (financialOnly && !can('financeiro_manage'))) return
    setSaving(key); setMessage('')
    const { data: auth } = await supabase.auth.getUser()
    const { error } = await supabase.from('app_notes').upsert({ key, content: notes[key], updated_by: auth.user?.id ?? null })
    setSaving(null)
    setMessage(error ? error.message : 'Anotação salva.')
  }

  return <section className="dashboard-notes-grid">
    {definitions.filter(note => !financialOnly || note.key === 'financial').map(note => <article className="card dashboard-note" key={note.key}>
      <h2>{note.title}</h2>
      <textarea aria-label={note.title} readOnly={financialOnly && !can('financeiro_manage')} value={notes[note.key]} onChange={event => setNotes(value => ({ ...value, [note.key]: event.target.value }))} />
      {(!financialOnly || can('financeiro_manage')) && <button className="secondary" disabled={saving === note.key} onClick={() => void save(note.key)}>{saving === note.key ? 'Salvando…' : 'Salvar anotação'}</button>}
    </article>)}
    {message && <p className="form-message dashboard-notes-message" role="status">{message}</p>}
  </section>
}
