import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const ADMIN_EMAIL = 'talitapreviatti@gmail.com'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' })
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!url || !serviceKey || !token) return res.status(401).json({ error: 'Sessão não autorizada.' })
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data.user) return res.status(403).json({ error: 'Conta não autorizada para administração.' })
  const callerEmail = data.user.email?.toLowerCase()
  const { data: callerProfile } = await admin.from('user_profiles').select('role').eq('id', data.user.id).maybeSingle()
  if (callerEmail !== ADMIN_EMAIL && callerProfile?.role !== 'admin') return res.status(403).json({ error: 'Conta não autorizada para administração.' })
  const { error: updateError } = await admin.from('user_profiles').update({ role: 'admin', is_active: true }).eq('email', ADMIN_EMAIL)
  if (updateError) return res.status(500).json({ error: updateError.message })
  return res.status(200).json({ ok: true })
}
