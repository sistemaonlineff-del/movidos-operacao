import type { VercelRequest } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export class LabelApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'LabelApiError'
  }
}

export async function authorizeLabelReader(req: VercelRequest) {
  const authorization = req.headers.authorization
  const token = typeof authorization === 'string' ? /^Bearer\s+(\S+)$/i.exec(authorization)?.[1] : undefined
  if (!token) throw new LabelApiError(401, 'Sessão não autorizada. Entre novamente no sistema.')
  const url = process.env.SUPABASE_URL?.trim()
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !serviceKey) throw new LabelApiError(503, 'O serviço do leitor ainda não está configurado no servidor.')

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  const { data: auth, error: authError } = await admin.auth.getUser(token)
  if (authError || !auth.user) throw new LabelApiError(401, 'Sessão inválida. Entre novamente no sistema.')

  const { data: profile, error: profileError } = await admin.from('user_profiles')
    .select('role,is_active').eq('id', auth.user.id).maybeSingle()
  if (profileError) throw new LabelApiError(503, 'Não foi possível conferir o acesso ao leitor.')
  if (profile?.is_active !== true) throw new LabelApiError(403, 'Usuário sem acesso ao leitor.')
  if (profile.role === 'admin') return admin

  const { data: permissions, error: permissionsError } = await admin.from('user_module_permissions')
    .select('label_reader_access').eq('user_id', auth.user.id).maybeSingle()
  if (permissionsError) throw new LabelApiError(503, 'Não foi possível conferir a permissão do leitor.')
  if (permissions?.label_reader_access !== true) throw new LabelApiError(403, 'O leitor de etiquetas não está liberado para esta conta.')
  return admin
}