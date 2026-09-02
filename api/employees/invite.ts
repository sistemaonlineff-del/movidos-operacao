import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Método não permitido.' })
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return response.status(503).json({ error: 'Convites ainda não foram configurados no servidor.' })
  const token = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return response.status(401).json({ error: 'Sessão não encontrada.' })
  const service = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: auth, error: authError } = await service.auth.getUser(token)
  if (authError || !auth.user) return response.status(401).json({ error: 'Sessão inválida.' })
  const { data: profile } = await service.from('user_profiles').select('role,is_active').eq('id', auth.user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') return response.status(403).json({ error: 'Apenas administradores podem enviar convites.' })
  const employeeId = String(request.body?.employeeId ?? '')
  const { data: employee, error: employeeError } = await service.from('employees').select('id,full_name,personal_email,auth_user_id').eq('id', employeeId).single()
  if (employeeError || !employee) return response.status(404).json({ error: 'Funcionário não encontrado.' })
  if (employee.auth_user_id) return response.status(409).json({ error: 'Este funcionário já possui uma conta vinculada.' })
  const appUrl = process.env.APP_URL || 'https://movidos-operacao.vercel.app'
  const { error: inviteError } = await service.auth.admin.inviteUserByEmail(employee.personal_email, { data: { full_name: employee.full_name }, redirectTo: appUrl })
  if (inviteError) return response.status(400).json({ error: inviteError.message })
  return response.status(200).json({ ok: true })
}
