// @ts-nocheck
import { FormEvent, useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabase'
import './funcionarios.css'

type Employee = Record<string, any>
type Dependent = { id?: string; full_name: string; cpf: string; birth_date: string; relationship: string }

const fields = ['full_name','social_name','birth_date','gender','marital_status','nationality','birthplace','education_level','mother_name','father_name','cpf','rg_number','rg_issuer','rg_issue_date','pis_pasep','ctps_number','ctps_series','voter_registration','address','address_number','address_complement','neighborhood','municipality','state','postal_code','mobile_phone','emergency_phone','personal_email','admission_date','job_title','department','monthly_hours','work_shift','work_location','bank_name','bank_branch','bank_account','pix_key']
const blank = (): Employee => Object.fromEntries(fields.map(key => [key, '']))
const onlyDigits = (value: string) => value.replace(/\D/g, '')
const maskCpf = (value: string) => onlyDigits(value).slice(0, 11).replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2')
const formatRegistration = (value?: number) => value ? `FUNC-${String(value).padStart(6, '0')}` : 'Será gerada ao salvar'

function Field({ label, value, onChange, type = 'text', required = false }: any) {
  return <label className="employee-field">{label}<input type={type} required={required} value={value ?? ''} onChange={event => onChange(event.target.value)} /></label>
}
function Pick({ label, value, onChange, options }: any) {
  return <label className="employee-field">{label}<select value={value ?? ''} onChange={event => onChange(event.target.value)}><option value="">Selecionar</option>{options.map((option: string) => <option key={option} value={option}>{option}</option>)}</select></label>
}

export default function Funcionarios() {
  const [profile, setProfile] = useState<any>(null)
  const [items, setItems] = useState<Employee[]>([])
  const [value, setValue] = useState<Employee>(blank)
  const [dependents, setDependents] = useState<Dependent[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const put = (key: string, next: any) => setValue(current => ({ ...current, [key]: next }))

  const load = async () => {
    if (!supabase) return
    setLoading(true)
    const { data: session } = await supabase.auth.getSession()
    const userId = session.session?.user.id
    if (!userId) return
    const { data: currentProfile } = await supabase.from('user_profiles').select('role, full_name').eq('id', userId).single()
    setProfile(currentProfile)
    if (currentProfile?.role === 'admin') {
      const { data, error } = await supabase.from('employees').select('*').order('full_name')
      if (error) setMessage(error.message)
      else setItems(data ?? [])
    }
    setLoading(false)
  }
  useEffect(() => { void load() }, [])

  const shown = useMemo(() => {
    const term = query.trim().toLocaleLowerCase('pt-BR')
    return term ? items.filter(item => [item.employee_number, item.full_name, item.personal_email, item.department, item.job_title].join(' ').toLocaleLowerCase('pt-BR').includes(term)) : items
  }, [items, query])
  const reset = (clearMessage = true) => { setEditing(null); setValue(blank()); setDependents([]); if (clearMessage) setMessage('') }
  const edit = async (employee: Employee) => {
    setEditing(employee.id); setValue({ ...blank(), ...employee, cpf: maskCpf(employee.cpf ?? '') }); setMessage('')
    const { data, error } = await supabase!.from('employee_dependents').select('*').eq('employee_id', employee.id).order('full_name')
    setDependents(error ? [] : data ?? [])
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!supabase || !value.full_name.trim() || onlyDigits(value.cpf).length !== 11 || !value.personal_email.trim()) { setMessage('Informe nome completo, CPF válido e e-mail pessoal.'); return }
    setSaving(true); setMessage('')
    const payload: any = { ...value, cpf: onlyDigits(value.cpf), personal_email: value.personal_email.trim().toLowerCase(), state: value.state.toUpperCase() || null, monthly_hours: value.monthly_hours ? Number(value.monthly_hours) : null, created_by: editing ? undefined : (await supabase.auth.getUser()).data.user?.id }
    Object.keys(payload).forEach(key => { if (payload[key] === '') payload[key] = null; if (payload[key] === undefined) delete payload[key] })
    const response = editing ? await supabase.from('employees').update(payload).eq('id', editing).select().single() : await supabase.from('employees').insert(payload).select().single()
    if (response.error) { setMessage(response.error.message); setSaving(false); return }
    const employeeId = response.data.id
    const existing = dependents.filter(item => item.id).map(item => item.id)
    if (editing) { const removal = await supabase.from('employee_dependents').delete().eq('employee_id', employeeId).not('id', 'in', `(${existing.join(',') || '00000000-0000-0000-0000-000000000000'})`); if (removal.error) { setMessage(removal.error.message); setSaving(false); return } }
    for (const dependent of dependents) {
      if (!dependent.full_name.trim() || !dependent.relationship.trim()) continue
      const dependentPayload = { employee_id: employeeId, full_name: dependent.full_name.trim(), relationship: dependent.relationship.trim(), cpf: onlyDigits(dependent.cpf) || null, birth_date: dependent.birth_date || null }
      const result = dependent.id ? await supabase.from('employee_dependents').update(dependentPayload).eq('id', dependent.id) : await supabase.from('employee_dependents').insert(dependentPayload)
      if (result.error) { setMessage(result.error.message); setSaving(false); return }
    }
    setSaving(false); reset(false); setMessage(editing ? 'Funcionário atualizado com sucesso.' : 'Funcionário cadastrado com sucesso.'); await load()
  }
  const invite = async (employee: Employee) => {
    if (!confirm(`Enviar convite de acesso para ${employee.personal_email}?`)) return
    const { data: session } = await supabase!.auth.getSession()
    const response = await fetch('/api/employees/invite', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.session?.access_token ?? ''}` }, body: JSON.stringify({ employeeId: employee.id }) })
    const body = await response.json().catch(() => ({}))
    setMessage(response.ok ? 'Convite enviado para o e-mail do funcionário.' : (body.error ?? 'Não foi possível enviar o convite.'))
  }

  if (loading) return <section className="card">Carregando funcionários...</section>
  if (profile?.role !== 'admin') return <section className="card employee-locked"><p className="eyebrow">ACESSO RESTRITO</p><h2>Área de Funcionários</h2><p>Este módulo contém dados pessoais e financeiros e é acessível somente a administradores.</p></section>
  return <section className="employees"><div className="employee-title"><div><p className="eyebrow">GESTÃO DE PESSOAS</p><h2>{editing ? 'Editar funcionário' : 'Funcionários'}</h2><p>Dados pessoais, vínculo de trabalho, dependentes e acesso ao sistema.</p></div>{editing && <button className="secondary" type="button" onClick={reset}>Novo cadastro</button>}</div>
    <form className="employee-form" onSubmit={save}>
      <section><h3>Dados pessoais</h3><div className="employee-grid"><Field label="Nome completo" required value={value.full_name} onChange={(next: string) => put('full_name', next)} /><Field label="Nome social" value={value.social_name} onChange={(next: string) => put('social_name', next)} /><Field label="Data de nascimento" type="date" value={value.birth_date} onChange={(next: string) => put('birth_date', next)} /><Pick label="Gênero / sexo" value={value.gender} onChange={(next: string) => put('gender', next)} options={['Feminino','Masculino','Não informar','Outro']} /><Pick label="Estado civil" value={value.marital_status} onChange={(next: string) => put('marital_status', next)} options={['Solteiro(a)','Casado(a)','União estável','Divorciado(a)','Viúvo(a)']} /><Field label="Nacionalidade" value={value.nationality} onChange={(next: string) => put('nationality', next)} /><Field label="Naturalidade" value={value.birthplace} onChange={(next: string) => put('birthplace', next)} /><Field label="Escolaridade" value={value.education_level} onChange={(next: string) => put('education_level', next)} /><Field label="Nome da mãe" value={value.mother_name} onChange={(next: string) => put('mother_name', next)} /><Field label="Nome do pai" value={value.father_name} onChange={(next: string) => put('father_name', next)} /></div></section>
      <section><h3>Documentos</h3><div className="employee-grid"><Field label="CPF" required value={value.cpf} onChange={(next: string) => put('cpf', maskCpf(next))} /><Field label="RG" value={value.rg_number} onChange={(next: string) => put('rg_number', next)} /><Field label="Órgão emissor" value={value.rg_issuer} onChange={(next: string) => put('rg_issuer', next)} /><Field label="Data de emissão do RG" type="date" value={value.rg_issue_date} onChange={(next: string) => put('rg_issue_date', next)} /><Field label="PIS/PASEP" value={value.pis_pasep} onChange={(next: string) => put('pis_pasep', next)} /><Field label="CTPS (número)" value={value.ctps_number} onChange={(next: string) => put('ctps_number', next)} /><Field label="CTPS (série)" value={value.ctps_series} onChange={(next: string) => put('ctps_series', next)} /><Field label="Título de eleitor" value={value.voter_registration} onChange={(next: string) => put('voter_registration', next)} /></div></section>
      <section><h3>Contato e endereço</h3><div className="employee-grid"><Field label="E-mail pessoal" type="email" required value={value.personal_email} onChange={(next: string) => put('personal_email', next)} /><Field label="Celular" value={value.mobile_phone} onChange={(next: string) => put('mobile_phone', next)} /><Field label="Telefone para emergência" value={value.emergency_phone} onChange={(next: string) => put('emergency_phone', next)} /><Field label="CEP" value={value.postal_code} onChange={(next: string) => put('postal_code', next)} /><Field label="Rua" value={value.address} onChange={(next: string) => put('address', next)} /><Field label="Número" value={value.address_number} onChange={(next: string) => put('address_number', next)} /><Field label="Complemento" value={value.address_complement} onChange={(next: string) => put('address_complement', next)} /><Field label="Bairro" value={value.neighborhood} onChange={(next: string) => put('neighborhood', next)} /><Field label="Cidade" value={value.municipality} onChange={(next: string) => put('municipality', next)} /><Field label="UF" value={value.state} onChange={(next: string) => put('state', next)} /></div></section>
      <section><h3>Vínculo e pagamento</h3><div className="employee-grid"><Field label="Data de admissão" type="date" value={value.admission_date} onChange={(next: string) => put('admission_date', next)} /><Field label="Cargo / função" value={value.job_title} onChange={(next: string) => put('job_title', next)} /><Field label="Departamento / setor" value={value.department} onChange={(next: string) => put('department', next)} /><Field label="Carga horária mensal" type="number" value={value.monthly_hours} onChange={(next: string) => put('monthly_hours', next)} /><Field label="Jornada / turno" value={value.work_shift} onChange={(next: string) => put('work_shift', next)} /><Field label="Local de trabalho / filial" value={value.work_location} onChange={(next: string) => put('work_location', next)} /><Pick label="Permissão no sistema" value={value.access_role || 'operador'} onChange={(next: string) => put('access_role', next)} options={['operador','financeiro']} /><Pick label="Situação" value={value.employment_status || 'ativo'} onChange={(next: string) => put('employment_status', next)} options={['ativo','inativo','desligado']} /><Pick label="Vale-transporte" value={String(value.transport_voucher ?? false)} onChange={(next: string) => put('transport_voucher', next === 'true')} options={['true','false']} /><Field label="Banco" value={value.bank_name} onChange={(next: string) => put('bank_name', next)} /><Field label="Agência" value={value.bank_branch} onChange={(next: string) => put('bank_branch', next)} /><Field label="Conta" value={value.bank_account} onChange={(next: string) => put('bank_account', next)} /><Field label="Chave Pix" value={value.pix_key} onChange={(next: string) => put('pix_key', next)} /></div></section>
      <section><div className="dependent-heading"><h3>Dependentes</h3><button className="secondary" type="button" onClick={() => setDependents(current => [...current, { full_name: '', cpf: '', birth_date: '', relationship: '' }])}>+ Adicionar dependente</button></div>{dependents.map((dependent, index) => <div className="dependent-row" key={dependent.id ?? index}><Field label="Nome" value={dependent.full_name} onChange={(next: string) => setDependents(current => current.map((item, position) => position === index ? { ...item, full_name: next } : item))} /><Field label="Parentesco" value={dependent.relationship} onChange={(next: string) => setDependents(current => current.map((item, position) => position === index ? { ...item, relationship: next } : item))} /><Field label="CPF" value={dependent.cpf} onChange={(next: string) => setDependents(current => current.map((item, position) => position === index ? { ...item, cpf: maskCpf(next) } : item))} /><Field label="Nascimento" type="date" value={dependent.birth_date} onChange={(next: string) => setDependents(current => current.map((item, position) => position === index ? { ...item, birth_date: next } : item))} /><button className="danger-action" type="button" onClick={() => setDependents(current => current.filter((_, position) => position !== index))}>Remover</button></div>)}</section>
      {message && <p className="form-message">{message}</p>}<div className="modal-actions"><button type="button" onClick={reset}>Limpar</button><button className="primary compact" disabled={saving}>{saving ? 'Salvando...' : editing ? 'Salvar alterações' : 'Cadastrar funcionário'}</button></div>
    </form>
    <section className="card employee-list"><div className="employee-list-head"><h3>Funcionários cadastrados</h3><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Nome, matrícula, e-mail ou setor" /></div><div className="table-wrap"><table><thead><tr><th>Matrícula</th><th>Nome</th><th>Setor</th><th>Cargo</th><th>Acesso</th><th>Situação</th><th>Ações</th></tr></thead><tbody>{shown.map(employee => <tr key={employee.id}><td>{formatRegistration(employee.employee_number)}</td><td><strong>{employee.full_name}</strong><br /><small>{employee.personal_email}</small></td><td>{employee.department || '—'}</td><td>{employee.job_title || '—'}</td><td>{employee.access_role}</td><td>{employee.employment_status}</td><td className="action-cell"><button className="table-action" onClick={() => void edit(employee)}>Editar</button><button className="secondary small-action" onClick={() => void invite(employee)}>Convidar</button></td></tr>)}</tbody></table></div></section>
  </section>
}
