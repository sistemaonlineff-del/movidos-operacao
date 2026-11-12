import type { VercelRequest, VercelResponse } from '@vercel/node'
import { authorizeLabelReaderContext, LabelApiError } from './label-auth.js'
import { orderedDispatch, type DispatchVolume } from '../src/labelDispatch.js'

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const validDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Vary', 'Authorization')
  if (!['GET','POST'].includes(req.method ?? '')) { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Metodo nao permitido.' }) }
  try {
    const { admin, user, profile, dispatcher } = await authorizeLabelReaderContext(req)
    const day = req.method === 'GET' ? req.query.day : req.body?.day
    if (!validDay(day)) throw new LabelApiError(400, 'Informe uma data valida.')
    const requested = req.method === 'GET' ? req.query.driverId : req.body?.driverId
    if (requested && !uuid(requested)) throw new LabelApiError(400, 'Motorista invalido.')
    if (!dispatcher && requested && requested !== user.id) throw new LabelApiError(403, 'A lista de outro motorista nao esta liberada.')
    const driverId = dispatcher ? requested : user.id
    const rows: DispatchVolume[] = []
    for (let offset = 0; ; offset += 200) {
      let query = admin.from('delivery_volumes').select('id,driver_id,driver_name,recipient_address,address_confirmed,delivery_sequence,created_at,street,neighborhood,city,postal_code').eq('delivery_date', day).not('scan_key','is',null).order('created_at').order('id').range(offset, offset + 199)
      if (driverId) query = query.eq('driver_id', driverId)
      const result = await query
      if (result.error) {
        const code = /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(result.error.code ?? '') ? result.error.code : 'unknown'
        const missingSchema = ['42P01', '42703', 'PGRST204', 'PGRST205'].includes(code)
        console.error('label-dispatch storage error', { code, reason: missingSchema ? 'schema_missing' : code === '42501' ? 'permission_denied' : 'query_failed' })
        if (missingSchema) throw new LabelApiError(503, 'A lista de expedicao precisa de atualizacao no banco. Avise o administrador para conferir as migracoes do leitor.')
        if (code === '42501') throw new LabelApiError(503, 'O servidor esta sem permissao para consultar a expedicao. Avise o administrador.')
        throw new LabelApiError(503, 'Nao foi possivel consultar a expedicao no momento. Tente atualizar a lista; se persistir, avise o administrador.')
      }
      rows.push(...result.data as DispatchVolume[])
      if (result.data.length < 200) break
    }
    if (req.method === 'POST' && req.body?.mode === 'confirm-address') {
      const row = rows.find(item => item.id === req.body.id)
      const address = typeof req.body.address === 'string' ? req.body.address.trim() : ''
      if (!row?.driver_id || !address || address.length > 2000 || /[\x00-\x1f]/.test(address)) throw new LabelApiError(400, 'Informe o endereco completo com numero, bairro e cidade.')
      const result = await admin.from('delivery_volumes').update({ recipient_address: address, address_confirmed: true }).eq('id', row.id).eq('driver_id', row.driver_id)
      if (result.error) throw new LabelApiError(409, 'Nao foi possivel confirmar o endereco.')
      return res.status(200).json({ saved: true })
    }
    if (req.method === 'POST' && req.body?.mode === 'optimize') {
      if (!driverId || rows.length < 2 || rows.length > 25) throw new LabelApiError(400, 'Selecione um motorista com 2 a 25 paradas para otimizar.')
      if (rows.some(row => !row.address_confirmed || !row.recipient_address)) throw new LabelApiError(400, 'Confira todos os enderecos antes de otimizar.')
      const origin = typeof req.body.origin === 'string' ? req.body.origin.trim() : ''
      if (!origin || origin.length > 500) throw new LabelApiError(400, 'Informe o endereco de partida.')
      const key = process.env.GOOGLE_ROUTES_API_KEY?.trim()
      if (!key) throw new LabelApiError(503, 'Otimizacao nao configurada. Os links comuns mantem a sequencia da base.')
      const ordered = orderedDispatch(rows), destination = ordered[ordered.length - 1]
      const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'routes.optimizedIntermediateWaypointIndex' }, body: JSON.stringify({ origin: { address: origin }, destination: { address: destination.recipient_address }, intermediates: ordered.slice(0,-1).map(row => ({ address: row.recipient_address })), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE', optimizeWaypointOrder: true }), signal: AbortSignal.timeout(20000) })
      if (!response.ok) throw new LabelApiError(502, 'O Google nao conseguiu otimizar. Nenhuma lista foi alterada.')
      const result = await response.json(), indices = result.routes?.[0]?.optimizedIntermediateWaypointIndex
      if (!Array.isArray(indices) || indices.length !== ordered.length - 1 || new Set(indices).size !== indices.length || indices.some(index => !Number.isInteger(index) || index < 0 || index >= ordered.length - 1)) throw new LabelApiError(502, 'Ordem de rota invalida recebida do Google.')
      return res.status(200).json({ ids: [...indices.map(index => ordered[index].id), destination.id] })
    }
    if (req.method !== 'GET') throw new LabelApiError(400, 'Acao invalida.')
    const drivers = [{ id: user.id, name: profile.full_name || 'Minha conta' }]
    if (dispatcher) {
      const profiles: { id: string; full_name: string | null; role: string }[] = [], permissions = new Set<string>()
      for (let offset = 0; ; offset += 200) {
        const result = await admin.from('user_module_permissions').select('user_id').eq('label_reader_access',true).order('user_id').range(offset,offset+199)
        if (result.error) throw new LabelApiError(503, 'Nao foi possivel listar motoristas.')
        result.data.forEach(item => permissions.add(item.user_id)); if (result.data.length < 200) break
      }
      for (let offset = 0; ; offset += 200) {
        const result = await admin.from('user_profiles').select('id,full_name,role').eq('is_active',true).order('id').range(offset,offset+199)
        if (result.error) throw new LabelApiError(503, 'Nao foi possivel listar motoristas.')
        profiles.push(...result.data); if (result.data.length < 200) break
      }
      drivers.splice(0,drivers.length,...profiles.filter(item => item.role === 'admin' || permissions.has(item.id)).map(item => ({ id: item.id, name: item.full_name || `Motorista ${item.id.slice(0,8)}` })))
    }
    return res.status(200).json({ rows: orderedDispatch(rows), drivers, dispatcher, currentUserId: user.id, optimizationConfigured: Boolean(process.env.GOOGLE_ROUTES_API_KEY?.trim()) })
  } catch (failure) {
    if (failure instanceof LabelApiError) return res.status(failure.status).json({ error: failure.message })
    return res.status(503).json({ error: 'Servico de expedicao indisponivel. Tente novamente.' })
  }
}