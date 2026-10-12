import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const bucket = 'movidos-documents'
const configPaths = { serviceTemplatePath: 'contract-templates/config.json', terminationTemplatePath: 'contract-templates/termination-config.json' }

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

async function readConfig(admin: SupabaseClient, field: keyof typeof configPaths) {
  const { data, error } = await admin.storage.from(bucket).download(configPaths[field])
  if (error || !data) {
    if (error && !['404','400'].includes(String(error.statusCode))) throw new Error('Não foi possível consultar o modelo ativo.')
    return ''
  }
  try {
    const parsed = JSON.parse(await data.text())
    return typeof parsed[field] === 'string' ? parsed[field] : ''
  } catch { throw new Error('Configuração de modelo inválida.') }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  try {
    const { admin, isAdmin } = await clientFor(req)
    if (req.method === 'GET') return res.status(200).json({serviceTemplatePath:await readConfig(admin,'serviceTemplatePath'),terminationTemplatePath:await readConfig(admin,'terminationTemplatePath')})
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' })
    if (!isAdmin) return res.status(403).json({ error: 'Somente a administradora pode alterar o modelo.' })
    const fields = Object.keys(req.body ?? {})
    if(fields.length!==1 || !Object.hasOwn(configPaths,fields[0])) return res.status(400).json({error:'Informe somente um modelo por alteração.'})
    const field=fields[0] as keyof typeof configPaths
    const path = req.body[field]
    const kind=field==='serviceTemplatePath'?'service':'termination'
    if (typeof path!=='string' || (path && !new RegExp(`^contract-templates/${kind}/[a-zA-Z0-9_-][a-zA-Z0-9._-]*\\.docx$`).test(path))) return res.status(400).json({ error: 'Modelo inválido.' })
    const { error } = await admin.storage.from(bucket).upload(configPaths[field], new Blob([JSON.stringify({ [field]: path })], { type: 'application/json' }), { upsert: true, contentType: 'application/json' })
    if (error) throw error
    return res.status(200).json({ [field]: path })
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : 'Não foi possível atualizar o modelo.' })
  }
}
