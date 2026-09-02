// @ts-nocheck
import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from './lib/supabase'

const AccessContext = createContext<any>({ loading: true, isAdmin: false, can: () => false, refresh: async () => {} })
export const permissionLabels: Record<string, string> = {
  cadastros_view: 'Ver cadastros', cadastros_create: 'Criar cadastros', cadastros_edit: 'Editar cadastros', cadastros_delete: 'Excluir cadastros',
  financeiro_view: 'Ver Financeiro', financeiro_manage: 'Gerenciar Financeiro',
  funcionarios_view: 'Ver Funcionários', funcionarios_manage: 'Gerenciar Funcionários', configuracoes_manage: 'Configurações'
}
export function AccessProvider({ children }: any) {
  const [state, setState] = useState<any>({ loading: true, profile: null, permissions: {} })
  const refresh = async () => {
    if (!supabase) return setState({ loading: false, profile: null, permissions: {} })
    const { data: auth } = await supabase.auth.getUser()
    if (!auth.user) return setState({ loading: false, profile: null, permissions: {} })
    const [{ data: profile }, { data: permissions }] = await Promise.all([
      supabase.from('user_profiles').select('id,email,full_name,role,is_active').eq('id', auth.user.id).single(),
      supabase.from('user_module_permissions').select('*').eq('user_id', auth.user.id).maybeSingle()
    ])
    setState({ loading: false, profile, permissions: permissions ?? {} })
  }
  useEffect(() => { void refresh() }, [])
  const isAdmin = state.profile?.role === 'admin' && state.profile?.is_active
  const can = (name: string) => Boolean(isAdmin || state.permissions?.[name])
  return <AccessContext.Provider value={{ ...state, isAdmin, can, refresh }}>{children}</AccessContext.Provider>
}
export const useAccess = () => useContext(AccessContext)
export function Guard({ permission, children }: any) {
  const { loading, can } = useAccess()
  if (loading) return <section className="card">Carregando permissões...</section>
  if (!can(permission)) return <section className="card employee-locked"><p className="eyebrow">ACESSO RESTRITO</p><h2>Sem permissão</h2><p>Peça a um administrador para liberar este módulo para sua conta.</p></section>
  return children
}
