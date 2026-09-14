import type { VercelRequest, VercelResponse } from '@vercel/node'
import { authorizeLabelReader, LabelApiError } from '../server/label-auth.js'

const dateInBrazil = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('/').reverse().join('-')

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0'); res.setHeader('Vary', 'Authorization')
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Método não permitido.' }) }
  try {
    const baseId = typeof req.body?.baseId === 'string' ? req.body.baseId : ''
    const scanKey = typeof req.body?.scanKey === 'string' && /^[a-zA-Z0-9_-]{16,100}$/.test(req.body.scanKey) ? req.body.scanKey : ''
    if (!baseId || !scanKey) throw new LabelApiError(400, 'Leitura inválida para armazenamento.')
    const admin = await authorizeLabelReader(req)
    const { data: existing, error: existingError } = await admin.from('delivery_volumes').select('zone,route,batch_number,delivery_sequence').eq('scan_key', scanKey).maybeSingle()
    if (existingError && !/scan_key/i.test(existingError.message)) throw existingError
    if (existing) return res.status(200).json({ saved: true, duplicate: true, zone: existing.zone, route: existing.route, batch: existing.batch_number, sequence: existing.delivery_sequence })
    const { data: base, error: baseError } = await admin.from('delivery_route_base').select('street,neighborhood,city,postal_code,zone,route,delivery_sequence').eq('id', baseId).eq('is_active', true).maybeSingle()
    if (baseError || !base) throw new LabelApiError(404, 'O endereço não está mais disponível na base de rotas.')
    const deliveryDate = dateInBrazil()
    const { data: lastBatch, error: lastError } = await admin.from('delivery_volumes').select('batch_number').eq('delivery_date', deliveryDate).eq('zone', base.zone).eq('route', base.route).order('batch_number', { ascending: false }).limit(1)
    if (lastError) throw lastError
    let batch = lastBatch?.[0]?.batch_number ?? 1
    const { count, error: countError } = await admin.from('delivery_volumes').select('id', { count: 'exact', head: true }).eq('delivery_date', deliveryDate).eq('zone', base.zone).eq('route', base.route).eq('batch_number', batch)
    if (countError) throw countError
    if ((count ?? 0) >= 100) batch += 1
    const { error: insertError } = await admin.from('delivery_volumes').insert({ delivery_date: deliveryDate, zone: base.zone, route: base.route, batch_number: batch, street: base.street, neighborhood: base.neighborhood, city: base.city, postal_code: base.postal_code, delivery_sequence: base.delivery_sequence, scan_key: scanKey })
    if (insertError) {
      if (/scan_key/i.test(insertError.message)) return res.status(200).json({ saved: true, duplicate: true, zone: base.zone, route: base.route, batch })
      throw insertError
    }
    return res.status(201).json({ saved: true, duplicate: false, zone: base.zone, route: base.route, batch, sequence: base.delivery_sequence })
  } catch (error) {
    if (error instanceof LabelApiError) return res.status(error.status).json({ error: error.message })
    return res.status(503).json({ error: 'Não foi possível adicionar este volume à pré-rota. Tente novamente.' })
  }
}
