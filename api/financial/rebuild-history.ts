import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

type HistoryRow = { period: string; drop: string; partner: string; quantity: number; agreed: number }
const text = (value: unknown) => String(value ?? '').trim()
const number = (value: unknown) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const raw = text(value)
  return Number(raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw) || 0
}
const dropKey = (value: unknown) => text(value).toLocaleUpperCase('pt-BR')
const chunk = <T,>(rows: T[], size = 400) => Array.from({ length: Math.ceil(rows.length / size) }, (_, index) => rows.slice(index * size, index * size + size))

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' })
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!url || !serviceKey || !token) return res.status(401).json({ error: 'Sessão não autorizada.' })

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  const { data: auth, error: authError } = await admin.auth.getUser(token)
  if (authError || !auth.user) return res.status(401).json({ error: 'Sessão inválida.' })
  const { data: profile } = await admin.from('user_profiles').select('role,is_active').eq('id', auth.user.id).maybeSingle()
  if (!profile?.is_active || !['admin', 'financeiro'].includes(profile.role)) return res.status(403).json({ error: 'Apenas Financeiro ou Administrador pode substituir o histórico.' })

  const input = Array.isArray(req.body?.rows) ? req.body.rows : []
  const rows: HistoryRow[] = input.map((row: any) => ({
    period: text(row.period),
    drop: text(row.drop),
    partner: text(row.partner) || 'SEM PARCEIRO',
    quantity: Math.max(0, Math.trunc(number(row.quantity))),
    agreed: number(row.agreed),
  })).filter(row => row.period && row.drop)
  if (!rows.length || rows.length > 10000) return res.status(400).json({ error: 'Arquivo histórico vazio ou fora do limite.' })

  try {
    await admin.from('loss_events').delete().not('id', 'is', null)
    await admin.from('financial_drop_items').delete().not('id', 'is', null)
    await admin.from('financial_periods').delete().not('id', 'is', null)
    const { error: viewDeleteError } = await admin.from('financial_views').delete().not('id', 'is', null)
    if (viewDeleteError) throw viewDeleteError

    const byPeriod = new Map<string, HistoryRow[]>()
    const periodOrder: string[] = []
    const latestAgreement = new Map<string, number>()
    for (const row of rows) {
      const agreed = row.agreed || latestAgreement.get(dropKey(row.drop)) || 0
      if (agreed > 0) latestAgreement.set(dropKey(row.drop), agreed)
      const normalized = { ...row, agreed }
      if (!byPeriod.has(row.period)) { byPeriod.set(row.period, []); periodOrder.push(row.period) }
      byPeriod.get(row.period)?.push(normalized)
    }

    let lastViewId = ''
    for (const label of periodOrder) {
      const periodRows = byPeriod.get(label) ?? []
      const { data: view, error: viewError } = await admin.from('financial_views').insert({
        title: label, source_file_name: 'Pasta1.xlsx', source_rows: periodRows.length,
        import_status: 'rascunho', notes: 'Histórico geral importado do Pasta1.xlsx',
      }).select().single()
      if (viewError || !view) throw viewError ?? new Error('Não foi possível criar a View histórica.')
      lastViewId = view.id
      const partners = [...new Set(periodRows.map(row => row.partner))]
      const { data: financialPeriods, error: periodError } = await admin.from('financial_periods').insert(partners.map(partner => ({
        label, partner, financial_view_id: view.id, status: 'aberto',
      }))).select()
      if (periodError) throw periodError
      const periodId = new Map((financialPeriods ?? []).map(item => [item.partner, item.id]))
      for (const part of chunk(periodRows)) {
        const { error } = await admin.from('financial_drop_items').insert(part.map(row => ({
          financial_period_id: periodId.get(row.partner), drop_name_snapshot: row.drop,
          quantity_packages: row.quantity, unit_value: row.agreed, reimbursement: 0,
        })))
        if (error) throw error
      }
      const { error: completeError } = await admin.from('financial_views').update({ import_status: 'importado' }).eq('id', view.id)
      if (completeError) throw completeError
    }
    return res.status(200).json({ views: periodOrder.length, rows: rows.length, lastViewId })
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Falha ao reconstruir o histórico.' })
  }
}
