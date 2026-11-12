import type { VercelRequest, VercelResponse } from '@vercel/node'
import { authorizeLabelReaderContext, LabelApiError } from '../server/label-auth.js'
import dispatch from '../server/label-dispatch.js'

const dateInBrazil = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('/').reverse().join('-')

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.query?.__labelDispatch === '1') return dispatch(req, res)
  res.setHeader('Cache-Control', 'private, no-store, max-age=0'); res.setHeader('Vary', 'Authorization')
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Método não permitido.' }) }
  try {
    const baseId = typeof req.body?.baseId === 'string' ? req.body.baseId : ''
    const scanKey = typeof req.body?.scanKey === 'string' && /^[a-zA-Z0-9_-]{16,100}$/.test(req.body.scanKey) ? req.body.scanKey : ''
    if (!baseId || !scanKey) throw new LabelApiError(400, 'Leitura inválida para armazenamento.')
    const captureNumber = req.body?.captureNumber ?? null
    if (captureNumber !== null && (typeof captureNumber !== 'number' || !Number.isInteger(captureNumber) || captureNumber < 1 || captureNumber > 2147483647)) throw new LabelApiError(400, 'Numero da foto invalido.')
    const { admin, user, profile, dispatcher } = await authorizeLabelReaderContext(req)
    const driverId = req.body?.driverId ?? user.id
    if (typeof driverId !== 'string' || !/^[0-9a-f-]{36}$/i.test(driverId)) throw new LabelApiError(400, 'Escolha o motorista.')
    if (!dispatcher && driverId !== user.id) throw new LabelApiError(403, 'Voce so pode atribuir volumes a sua propria conta.')
    let driverName = profile.full_name || 'Motorista'
    if (driverId !== user.id) {
      const target = await admin.from('user_profiles').select('full_name,role,is_active').eq('id', driverId).maybeSingle()
      const permission = await admin.from('user_module_permissions').select('label_reader_access').eq('user_id', driverId).maybeSingle()
      if (target.error || permission.error || !target.data?.is_active || (target.data.role !== 'admin' && !permission.data?.label_reader_access)) throw new LabelApiError(400, 'Motorista inativo ou sem permissao de leitura.')
      driverName = target.data.full_name || 'Motorista'
    }
    const packageAddress = typeof req.body?.packageAddress === 'string' ? req.body.packageAddress.trim() : ''
    if (packageAddress.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(packageAddress)) throw new LabelApiError(400, 'Endereco invalido.')
    const { data: existing, error: existingError } = await admin.from('delivery_volumes').select('zone,route,batch_number,delivery_sequence,driver_id,capture_number').eq('scan_key', scanKey).maybeSingle()
    if (existingError) throw existingError
    if (existing) {
      if (existing.driver_id !== driverId) throw new LabelApiError(409, 'Esta leitura ja pertence a outro motorista ou ao historico anterior. Nao foi reatribuida.')
      return res.status(200).json({ saved: true, duplicate: true, zone: existing.zone, route: existing.route, batch: existing.batch_number, sequence: existing.delivery_sequence, captureNumber: existing.capture_number ?? null })
    }
    const { data: base, error: baseError } = await admin.from('delivery_route_base').select('street,neighborhood,city,postal_code,zone,route,delivery_sequence').eq('id', baseId).eq('is_active', true).maybeSingle()
    if (baseError || !base) throw new LabelApiError(404, 'O endereço não está mais disponível na base de rotas.')
    const deliveryDate = dateInBrazil()
    const { data: lastBatch, error: lastError } = await admin.from('delivery_volumes').select('batch_number').eq('delivery_date', deliveryDate).eq('zone', base.zone).eq('route', base.route).order('batch_number', { ascending: false }).limit(1)
    if (lastError) throw lastError
    let batch = lastBatch?.[0]?.batch_number ?? 1
    const { count, error: countError } = await admin.from('delivery_volumes').select('id', { count: 'exact', head: true }).eq('delivery_date', deliveryDate).eq('zone', base.zone).eq('route', base.route).eq('batch_number', batch)
    if (countError) throw countError
    if ((count ?? 0) >= 100) batch += 1
    const { error: insertError } = await admin.from('delivery_volumes').insert({ delivery_date: deliveryDate, zone: base.zone, route: base.route, batch_number: batch, street: base.street, neighborhood: base.neighborhood, city: base.city, postal_code: base.postal_code, delivery_sequence: base.delivery_sequence, scan_key: scanKey, capture_number: captureNumber, driver_id: driverId, driver_name: String(driverName).slice(0,200), created_by: user.id, recipient_address: packageAddress || null, address_confirmed: Boolean(packageAddress && req.body?.addressConfirmed === true) })
    if (insertError) {
      if (insertError.code === '23505') {
        const winner = await admin.from('delivery_volumes').select('driver_id,capture_number').eq('scan_key', scanKey).maybeSingle()
        if (!winner.error && winner.data?.driver_id === driverId) return res.status(200).json({ saved: true, duplicate: true, zone: base.zone, route: base.route, batch, sequence: base.delivery_sequence, captureNumber: winner.data.capture_number ?? null })
        throw new LabelApiError(409, 'Leitura ja reservada. Atualize a lista antes de continuar.')
      }
      throw insertError
    }
    return res.status(201).json({ saved: true, duplicate: false, zone: base.zone, route: base.route, batch, sequence: base.delivery_sequence, captureNumber })
  } catch (error) {
    if (error instanceof LabelApiError) return res.status(error.status).json({ error: error.message, retryable: false })
    const rawCode = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
    const code = /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(rawCode) ? rawCode : 'unknown'
    const schemaMissing = ['42P01', '42703', 'PGRST204', 'PGRST205'].includes(code)
    const temporary = code === 'unknown' || /^(08|53|57|58)/.test(code) || ['PGRST000', 'PGRST001', 'PGRST002'].includes(code)
    console.error('label-volume storage error', { code, reason: schemaMissing ? 'schema_missing' : temporary ? 'storage_unavailable' : 'storage_rejected' })
    if (schemaMissing) return res.status(503).json({ error: 'A pre-rota precisa de atualizacao no banco de dados. Avise o administrador; este volume nao foi salvo.', retryable: false })
    if (!temporary) return res.status(503).json({ error: 'O banco recusou o volume. Avise o administrador para conferir a configuracao da pre-rota.', retryable: false })
    return res.status(503).json({ error: 'Não foi possível adicionar este volume à pré-rota. Tente novamente.', retryable: true })
  }
}
