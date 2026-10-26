import { ChangeEvent, useEffect, useRef, useState } from 'react'
import { useAccess } from './access'
import { supabase } from './lib/supabase'

export const employeeDocumentsBucket = 'employee-documents'
const maximumSize = 15 * 1024 * 1024
const formats: Record<string, { mime: string; extension: string }> = {
  pdf: { mime: 'application/pdf', extension: 'pdf' },
  doc: { mime: 'application/msword', extension: 'doc' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: 'docx' },
  jpg: { mime: 'image/jpeg', extension: 'jpg' },
  jpeg: { mime: 'image/jpeg', extension: 'jpg' },
  png: { mime: 'image/png', extension: 'png' },
  webp: { mime: 'image/webp', extension: 'webp' },
}
export type EmployeeDocument = {
  id: string; employee_id: string; file_name: string; storage_path: string
  mime_type: string; size_bytes: number; status: 'pending' | 'ready'; created_at: string
}
type Client = NonNullable<typeof supabase>

const fail = (error: unknown): never => { throw error }
const errorText = (error: unknown) => error && typeof error === 'object' && 'message' in error
  ? String(error.message) : 'Nao foi possivel concluir a operacao.'

export async function validateEmployeeDocument(file: File) {
  const format = formats[file.name.split('.').pop()?.toLowerCase() ?? '']
  if (!format || /[\x00-\x1f\x7f/\\]/.test(file.name) || file.name.length > 250) {
    throw new Error('Selecione um arquivo PDF, Word, JPEG, PNG ou WebP com nome de ate 250 caracteres.')
  }
  if (!file.size || file.size > maximumSize) throw new Error('O arquivo deve ter entre 1 byte e 15 MB.')
  if (file.type && file.type !== format.mime) throw new Error('O tipo do arquivo nao corresponde a extensao.')
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  const starts = (...bytes: number[]) => bytes.every((value, index) => header[index] === value)
  const valid = format.extension === 'pdf' ? starts(37, 80, 68, 70, 45)
    : format.extension === 'doc' ? starts(208, 207, 17, 224, 161, 177, 26, 225)
    : format.extension === 'docx' ? starts(80, 75, 3, 4)
    : format.extension === 'jpg' ? starts(255, 216, 255)
    : format.extension === 'png' ? starts(137, 80, 78, 71, 13, 10, 26, 10)
    : starts(82, 73, 70, 70) && header[8] === 87 && header[9] === 69 && header[10] === 66 && header[11] === 80
  if (!valid) throw new Error('O conteudo do arquivo nao corresponde ao formato selecionado.')
  return format
}

export async function listEmployeeDocuments(client: Client, employeeId: string) {
  const { data, error } = await client.from('employee_documents')
    .select('id,employee_id,file_name,storage_path,mime_type,size_bytes,status,created_at')
    .eq('employee_id', employeeId).in('status', ['pending', 'ready']).order('created_at', { ascending: false })
  if (error) fail(error)
  return (data ?? []) as EmployeeDocument[]
}

export async function confirmEmployeeDocument(client: Client, item: Pick<EmployeeDocument, 'id' | 'employee_id'>) {
  const { data, error } = await client.from('employee_documents').update({ status: 'ready' })
    .eq('id', item.id).eq('employee_id', item.employee_id).eq('status', 'pending').select('id').single()
  if (error) fail(error)
  if (!data) throw new Error('Documento alterado por outra pessoa. Atualize a lista.')
}

export async function uploadEmployeeDocument(client: Client, employeeId: string, file: File) {
  const format = await validateEmployeeDocument(file)
  const id = crypto.randomUUID()
  const item = { id, employee_id: employeeId, file_name: file.name, mime_type: format.mime,
    size_bytes: file.size, storage_path: `employees/${employeeId}/${id}/file.${format.extension}` }
  const { error: reservationError } = await client.from('employee_documents').insert(item).select('id').single()
  if (reservationError) fail(reservationError)
  const { error: uploadError } = await client.storage.from(employeeDocumentsBucket)
    .upload(item.storage_path, file, { contentType: format.mime, upsert: false })
  if (uploadError) fail(uploadError)
  await confirmEmployeeDocument(client, item)
}

export async function deleteEmployeeDocument(client: Client, item: EmployeeDocument) {
  const { error: storageError } = await client.storage.from(employeeDocumentsBucket).remove([item.storage_path])
  if (storageError) fail(storageError)
  const { error, data } = await client.from('employee_documents').update({ status: 'deleted' })
    .eq('id', item.id).eq('employee_id', item.employee_id).in('status', ['pending', 'ready']).select('id').single()
  if (error) fail(error)
  if (!data) throw new Error('Exclusao nao confirmada. Atualize a lista antes de tentar novamente.')
}

export default function EmployeeDocuments({ employeeId, employeeName, onClose }: {
  employeeId: string; employeeName: string; onClose: () => void
}) {
  const { can, profile } = useAccess()
  const canRead = Boolean(profile?.is_active && (can('funcionarios_view') || can('funcionarios_manage')))
  const canManage = Boolean(profile?.is_active && can('funcionarios_manage'))
  const [documents, setDocuments] = useState<EmployeeDocument[]>([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [message, setMessage] = useState('')
  const [notice, setNotice] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const lock = useRef(false)
  const mounted = useRef(false)
  const loadGeneration = useRef(0)

  const load = async () => {
    const generation = ++loadGeneration.current
    setLoading(true)
    try {
      if (!supabase || !canRead) throw new Error('Sem acesso aos documentos deste funcionario.')
      const rows = await listEmployeeDocuments(supabase, employeeId)
      if (mounted.current && generation === loadGeneration.current) { setDocuments(rows); setLoadFailed(false) }
    } catch (error) {
      if (mounted.current && generation === loadGeneration.current) {
        setDocuments([]); setLoadFailed(true); setMessage(errorText(error))
      }
    } finally {
      if (mounted.current && generation === loadGeneration.current) setLoading(false)
    }
  }
  useEffect(() => {
    mounted.current = true
    setDocuments([]); setMessage(''); setNotice('')
    void load()
    return () => { mounted.current = false; loadGeneration.current++ }
  }, [employeeId, canRead, canManage])
  useEffect(() => {
    title.current?.focus({ preventScroll: true })
    title.current?.scrollIntoView({ block: 'start' })
  }, [employeeId, canRead])

  const run = async (action: () => Promise<void>, success: string, manage = true) => {
    if (lock.current || !supabase || !canRead || (manage && !canManage)) return
    lock.current = true
    setBusy(true); setMessage(''); setNotice('')
    try {
      await action()
      if (mounted.current) setNotice(success)
    } catch (error) {
      if (mounted.current) setMessage(`${errorText(error)}${manage ? ' A operacao pode estar incompleta; confira a lista antes de repetir.' : ''}`)
    } finally {
      if (input.current) input.current.value = ''
      if (mounted.current) { await load(); setBusy(false) }
      lock.current = false
    }
  }
  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) void run(() => uploadEmployeeDocument(supabase!, employeeId, file), 'Documento salvo.')
  }
  const download = (item: EmployeeDocument) => run(async () => {
    const { data, error } = await supabase!.storage.from(employeeDocumentsBucket).download(item.storage_path)
    if (error) fail(error)
    if (!data || data.size !== Number(item.size_bytes)) throw new Error('Arquivo incompleto. Download cancelado.')
    const url = URL.createObjectURL(data)
    const link = window.document.createElement('a')
    link.href = url; link.download = item.file_name
    window.document.body.appendChild(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, 'Download iniciado.', false)

  if (!canRead) return null
  return <section className="employee-documents" aria-label={`Documentos de ${employeeName}`} aria-busy={busy || loading}>
    <div className="employee-documents-head"><h3 ref={title} tabIndex={-1}>Documentos de {employeeName}</h3>
      <div className="employee-documents-actions">
        {canManage && <><input ref={input} type="file" aria-label="Selecionar documento do funcionario" hidden
          accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp" disabled={busy || loading || loadFailed} onChange={upload} />
          <button type="button" className="secondary" disabled={busy || loading || loadFailed} onClick={() => input.current?.click()}>Anexar documento</button></>}
        <button type="button" className="secondary" disabled={busy || loading} onClick={() => { setMessage(''); void load() }}>Atualizar</button>
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>Fechar</button>
      </div>
    </div>
    {loading ? <p role="status">Carregando documentos...</p> : !loadFailed && <>
      {!documents.length && <p>Nenhum documento anexado.</p>}
      <ul className="employee-document-list">{documents.map(item => <li key={item.id}>
        <div><strong>{item.file_name}</strong><small>{(Number(item.size_bytes) / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} KB
          {' | '}{new Date(item.created_at).toLocaleString('pt-BR')}{item.status === 'pending' ? ' | Envio pendente' : ''}</small></div>
        <div className="employee-documents-actions">
          {item.status === 'ready' && <button type="button" className="secondary" disabled={busy} aria-label={`Baixar ${item.file_name}`} onClick={() => void download(item)}>Baixar</button>}
          {canManage && item.status === 'pending' && <button type="button" className="secondary" disabled={busy}
            onClick={() => void run(() => confirmEmployeeDocument(supabase!, item), 'Documento confirmado.')}>Confirmar envio</button>}
          {canManage && <button type="button" className="secondary employee-document-delete" disabled={busy} aria-label={`Excluir ${item.file_name}`}
            onClick={() => { if (!lock.current && window.confirm(`Excluir definitivamente o arquivo ${item.file_name}?`)) void run(() => deleteEmployeeDocument(supabase!, item), 'Documento excluido.') }}>Excluir</button>}
        </div>
      </li>)}</ul>
    </>}
    {busy && <p role="status">Processando documento...</p>}
    {message && <p className="error" role="alert">{message}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>
}