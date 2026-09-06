import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const bucket = 'movidos-documents'
const configPath = 'contract-templates/config.json'
const defaultConfig = { serviceTemplatePath: '' }

async function clientFor(req: VercelRequest) {
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!url || !serviceKey || !token) throw new Error('Sessão não autorizada.')
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data.user) throw new Error('Sessão inválida.')
  const { data: profile } = await admin.from('user_profiles').select('role,is_active').eq('id', data.user.id).maybeSingle()
  if (!profile?.is_active) throw new Error('Usuário sem acesso.')
  return { admin, isAdmin: profile.role === 'admin' }
}

async function readConfig(admin: ReturnType<typeof createClient>) {
  const { data, error } = await admin.storage.from(bucket).download(configPath)
  if (error || !data) return defaultConfig
  try {
    const parsed = JSON.parse(await data.text())
    return { serviceTemplatePath: typeof parsed.serviceTemplatePath === 'string' ? parsed.serviceTemplatePath : '' }
  } catch { return defaultConfig }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const { admin, isAdmin } = await clientFor(req)
    if (req.method === 'GET') return res.status(200).json(await readConfig(admin))
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' })
    if (!isAdmin) return res.status(403).json({ error: 'Somente a administradora pode alterar o modelo.' })
    const path = String(req.body?.serviceTemplatePath ?? '')
    if (path && !path.startsWith('contract-templates/service/')) return res.status(400).json({ error: 'Modelo inválido.' })
    const { error } = await admin.storage.from(bucket).upload(configPath, new Blob([JSON.stringify({ serviceTemplatePath: path })], { type: 'application/json' }), { upsert: true, contentType: 'application/json' })
    if (error) throw error
    return res.status(200).json({ serviceTemplatePath: path })
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : 'Não foi possível atualizar o modelo.' })
  }
}
