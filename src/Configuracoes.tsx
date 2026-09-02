// @ts-nocheck
import { useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabase'
import { permissionLabels, useAccess } from './access'
import './configuracoes.css'

const keys = Object.keys(permissionLabels)
const blank = Object.fromEntries(keys.map(key => [key, false]))
const presets: Record<string, any> = {
  'Somente cadastros': { cadastros_view: true },
  'Cadastros + novo cadastro': { cadastros_view: true, cadastros_create: true },
  'Cadastros completos': { cadastros_view: true, cadastros_create: true, cadastros_edit: true, cadastros_delete: true },
  'Somente Financeiro': { financeiro_view: true },
  'Financeiro completo': { financeiro_view: true, financeiro_manage: true },
  'Cadastros e Financeiro': { cadastros_view: true, cadastros_create: true, financeiro_view: true },
  'Somente Funcionários': { funcionarios_view: true },
  'Funcionários completos': { funcionarios_view: true, funcionarios_manage: true },
  'Sem acesso': {}
}
export default function Configuracoes() {
  const { isAdmin } = useAccess()
  const [users, setUsers] = useState<any[]>([])
  const [selected, setSelected] = useState<any>(null)
  const [permissions, setPermissions] = useState<any>(blank)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const load = async () => {
    if (!supabase || !isAdmin) return
    const [{ data: profiles, error }, { data: permissionRows }] = await Promise.all([
      supabase.from('user_profiles').select('id,email,full_name,role,is_active,created_at').order('created_at', { ascending: false }),
      supabase.from('user_module_permissions').select('*')
    ])
    if (error) setMessage(error.message)
    else setUsers((profiles ?? []).map(profile => ({ ...profile, permissions: (permissionRows ?? []).find(row => row.user_id === profile.id) ?? blank })))
  }
  useEffect(() => { void load() }, [isAdmin])
  const shown = useMemo(() => { const term = query.toLowerCase(); return users.filter(user => [user.full_name, user.email, user.role].join(' ').toLowerCase().includes(term)) }, [users, query])
  const choose = (user: any) => { setSelected(user); setPermissions({ ...blank, ...user.permissions }); setOpen(true); setMessage('') }
  const applyPreset = (name: string) => setPermissions({ ...blank, ...presets[name] })
  const save = async () => {
    if (!selected || !supabase) return
    const { error } = await supabase.from('user_module_permissions').upsert({ user_id: selected.id, ...permissions }, { onConflict: 'user_id' })
    if (error) { setMessage(error.message); return }
    setMessage('Permissões salvas. Elas entram em vigor no próximo acesso do usuário.'); await load()
  }
  if (!isAdmin) return <section className="card employee-locked"><p className="eyebrow">ACESSO RESTRITO</p><h2>Configurações</h2><p>Somente administradores controlam usuários.</p></section>
  return <section className="settings-page"><div className="settings-head"><div><p className="eyebrow">ADMINISTRAÇÃO</p><h2>Configurações</h2><p>Defina com precisão o que cada conta pode visualizar ou alterar.</p></div><button className="primary compact" onClick={() => { setOpen(true); setSelected(null); setPermissions(blank); setMessage('Selecione um usuário abaixo.') }}>Controle de usuários</button></div>
    <section className="card settings-intro"><h3>Controle de usuários</h3><p>Contas novas aparecem aqui sem acesso. Escolha um perfil pronto ou marque cada permissão individualmente.</p></section>
    <section className="card user-table"><div className="employee-list-head"><h3>Contas criadas</h3><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Pesquisar e-mail ou nome" /></div><div className="table-wrap"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Cargo</th><th>Status</th><th>Acesso</th><th></th></tr></thead><tbody>{shown.map(user => <tr key={user.id}><td>{user.full_name || '—'}</td><td>{user.email}</td><td>{user.role}</td><td>{user.is_active ? 'Ativo' : 'Inativo'}</td><td>{user.role === 'admin' ? 'Administrador completo' : keys.filter(key => user.permissions?.[key]).length + ' permissões'}</td><td><button className="table-action" onClick={() => choose(user)}>Configurar</button></td></tr>)}</tbody></table></div></section>
    {open && <div className="permission-modal"><div className="permission-panel"><div className="permission-top"><div><p className="eyebrow">CONTROLE DE USUÁRIOS</p><h3>{selected ? selected.email : 'Selecione uma conta'}</h3>{selected?.role === 'admin' && <p>Administradores têm acesso completo e não precisam de permissões adicionais.</p>}</div><button className="secondary" onClick={() => setOpen(false)}>Fechar</button></div>{selected && <><label className="employee-field">Perfil rápido<select onChange={event => applyPreset(event.target.value)} defaultValue=""><option value="" disabled>Escolher perfil</option>{Object.keys(presets).map(name => <option key={name}>{name}</option>)}</select></label><div className="permission-grid">{keys.map(key => <label key={key} className="permission-item"><input type="checkbox" checked={Boolean(permissions[key])} disabled={selected.role === 'admin'} onChange={event => setPermissions((current: any) => ({ ...current, [key]: event.target.checked }))} /><span>{permissionLabels[key]}</span></label>)}</div>{message && <p className="form-message">{message}</p>}<div className="modal-actions"><button className="primary compact" disabled={selected.role === 'admin'} onClick={() => void save()}>Salvar permissões</button></div></>}</div></div>}
  </section>
}
