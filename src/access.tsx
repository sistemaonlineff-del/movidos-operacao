// @ts-nocheck
import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { canManageDeliveryRoutes } from './routeAccess'
import { canAccessPrivateFinances } from './financasAccess'

const AccessContext = createContext<any>({ loading: true, isAdmin: false, can: () => false, refresh: async () => {} })
export const permissionLabels: Record<string, string> = {
  cadastros_view: 'Ver cadastros', cadastros_create: 'Criar cadastros', cadastros_edit: 'Editar cadastros', cadastros_delete: 'Excluir cadastros',
  financeiro_view: 'Ver Financeiro', financeiro_manage: 'Gerenciar Financeiro',
  funcionarios_view: 'Ver Funcionários', funcionarios_manage: 'Gerenciar Funcionários', configuracoes_manage: 'Configurações',
  label_reader_access: 'Leitor de etiquetas', delivery_routes_manage: 'Gerenciar rotas'
}
export function AccessProvider({ children, revalidateMs = 0 }: any) {
  const [state, setState] = useState<any>({ loading: true, profile: null, permissions: {} })
  const refresh = async () => {
    if (!supabase) return setState({ loading: false, profile: null, permissions: {} })
    const { data: auth } = await supabase.auth.getUser()
    if (!auth.user) return setState({ loading: false, profile: null, permissions: {} })
    if (auth.user.email?.toLowerCase() === 'talitapreviatti@gmail.com') {
      const { data: sessionData } = await supabase.auth.getSession()
      await fetch('/api/bootstrap-admin', { method: 'POST', headers: { Authorization: `Bearer ${sessionData.session?.access_token ?? ''}` } })
    }
    const [{ data: profile }, { data: permissions }] = await Promise.all([
      supabase.from('user_profiles').select('id,email,full_name,role,is_active').eq('id', auth.user.id).single(),
      supabase.from('user_module_permissions').select('*').eq('user_id', auth.user.id).maybeSingle()
    ])
    setState({ loading: false, profile, permissions: permissions ?? {}, canReadLabels: Boolean(profile?.is_active && (profile?.role === 'admin' || permissions?.label_reader_access)), canManageDeliveryRoutes: Boolean(profile?.is_active && (profile?.role === 'admin' || canManageDeliveryRoutes(auth.user.email) || permissions?.delivery_routes_manage === true)) })
  }
  useEffect(() => { void refresh() }, [])
  useEffect(() => {
    if (!revalidateMs) return
    const check = () => { void refresh().catch(() => setState({ loading: false, profile: null, permissions: {} })) }
    const visible = () => { if (document.visibilityState === 'visible') check() }
    const timer = window.setInterval(check, revalidateMs)
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', visible)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', visible) }
  }, [revalidateMs])
  const isAdmin = state.profile?.role === 'admin' && state.profile?.is_active
  const can = (name: string) => Boolean(state.profile?.is_active && (isAdmin || state.permissions?.[name]))
  return <AccessContext.Provider value={{ ...state, isAdmin, can, refresh, canAccessFinancas: canAccessPrivateFinances(state.profile?.email, state.profile?.is_active) }}>{children}</AccessContext.Provider>
}
export const useAccess = () => useContext(AccessContext)
export function Guard({ permission, children }: any) {
  const { loading, can } = useAccess()
  if (loading) return <section className="card">Carregando permissões...</section>
  if (!can(permission)) return <section className="card employee-locked"><p className="eyebrow">ACESSO RESTRITO</p><h2>Sem permissão</h2><p>Peça a um administrador para liberar este módulo para sua conta.</p></section>
  return children
}
