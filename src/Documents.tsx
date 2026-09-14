import { useEffect, useState } from 'react'
import DropDocuments from './DropDocuments'
import { supabase } from './lib/supabase'

type DropOption = { id: string; name: string; partner: string | null; legacy_id: number | null }

export default function Documents() {
  const [drops, setDrops] = useState<DropOption[]>([])
  const [selected, setSelected] = useState('')
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => {
    if (!supabase) return
    supabase.from('drops').select('id,name,partner,legacy_id').order('name').range(0, 9999).then(({ data, error }) => {
      if (error) setMessage(error.message)
      else setDrops((data ?? []) as DropOption[])
    })
  }, [])
  const options = drops.filter(drop => `${drop.legacy_id ?? ''} ${drop.name} ${drop.partner ?? ''}`.toLowerCase().includes(query.toLowerCase())).slice(0, 100)
  return <section className="documents-page">
    <section className="card visual-heading"><div><p className="eyebrow">ARQUIVOS DO CADASTRO</p><h2>Documentos</h2><p>Selecione um ponto para anexar e consultar contratos ou distratos.</p></div></section>
    <section className="card document-picker"><label>Buscar ponto<input value={query} onChange={event => { setQuery(event.target.value); setSelected('') }} placeholder="ID, nome do drop ou parceiro" /></label><label>Selecionar cadastro<select value={selected} onChange={event => setSelected(event.target.value)}><option value="">Selecionar</option>{options.map(drop => <option value={drop.id} key={drop.id}>{drop.legacy_id ? `${drop.legacy_id} · ` : ''}{drop.name}{drop.partner ? ` · ${drop.partner}` : ''}</option>)}</select></label>{query && options.length === 100 && <p className="financial-hint">Mostrando os primeiros 100 resultados. Refine a busca.</p>}{message && <p className="error">{message}</p>}</section>
    {selected ? <DropDocuments dropId={selected} /> : <section className="card empty-inline">Escolha um cadastro para gerenciar os documentos.</section>}
  </section>
}
