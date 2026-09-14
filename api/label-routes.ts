import type { VercelRequest, VercelResponse } from '@vercel/node'
import { authorizeLabelReader, LabelApiError } from '../server/label-auth.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0'); res.setHeader('Vary', 'Authorization')
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Método não permitido.' }) }
  try {
    const admin = await authorizeLabelReader(req)
    const { data, error } = await admin.from('delivery_route_base').select('id,street,neighborhood,city,postal_code,zone,route,delivery_sequence').eq('is_active', true).order('zone').order('route').order('delivery_sequence').order('postal_code')
    if (error) throw new LabelApiError(503, 'A base de rotas ainda não está disponível. Execute a preparação da base e importe o Excel.')
    return res.status(200).json({
      source: 'Base de rotas do Supabase', summary: [],
      records: (data ?? []).map(row => ({ id: row.id, street: row.street ?? '', neighborhood: row.neighborhood ?? '', city: row.city ?? '', postalCode: row.postal_code ?? '', zone: row.zone, route: row.route, deliverySequence: row.delivery_sequence, region: row.zone, mapsUrl: '', routeUrl: '', sourceSheet: 'Base de rotas', sourceRow: 0, sourceFile: 'Supabase' })),
    })
  } catch (error) {
    if (error instanceof LabelApiError) return res.status(error.status).json({ error: error.message })
    return res.status(503).json({ error: 'Não foi possível carregar a base de rotas. Tente novamente.' })
  }
}
