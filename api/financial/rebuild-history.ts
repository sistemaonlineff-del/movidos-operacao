import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

type HistoryRow = { period: string; drop: string; partner: string; quantity: number; agreed: number; subtotal: number; lossAmount: number; reimbursement: number; receivable: number; paymentDate: string | null; pixKey: string }
type LossRow = { period: string; drop: string; waybill: string; labelCode: string; bagCode: string; status: string; seller: string; receivedAt: string | null; amount: number; observation: string }
type DropRow = { name: string; partner: string; agreed: number; pixKey: string; email: string }
type SummaryRow = { period:string; observation:string; gross:number; w2d:number; d2d:number; loss:number; reimbursement:number; invoice:number; paidDrops:number; deducted:number; assumed:number; talitaJorge:number; paymentDate:string|null }
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
    subtotal: number(row.subtotal), lossAmount: number(row.lossAmount), reimbursement: number(row.reimbursement),
    receivable: number(row.receivable), paymentDate: text(row.paymentDate) || null, pixKey: text(row.pixKey),
  })).filter(row => row.period && row.drop)
  if (!rows.length || rows.length > 10000) return res.status(400).json({ error: 'Arquivo histórico vazio ou fora do limite.' })
  const losses: LossRow[] = (Array.isArray(req.body?.losses) ? req.body.losses : []).map((row: any) => ({
    period: text(row.period), drop: text(row.drop), waybill: text(row.waybill), labelCode: text(row.labelCode), bagCode: text(row.bagCode),
    status: text(row.status), seller: text(row.seller), receivedAt: text(row.receivedAt) || null, amount: number(row.amount), observation: text(row.observation),
  })).filter(row => row.period && row.drop)
  const drops: DropRow[] = (Array.isArray(req.body?.drops) ? req.body.drops : []).map((row: any) => ({
    name: text(row.name), partner: text(row.partner), agreed: number(row.agreed), pixKey: text(row.pixKey), email: text(row.email),
  })).filter(row => row.name)
  const sourceFile = text(req.body?.sourceFile) || 'Pasta1.xlsx'
  const summaries:SummaryRow[]=(Array.isArray(req.body?.summaries)?req.body.summaries:[]).map((row:any)=>({period:text(row.period),observation:text(row.observation),gross:number(row.gross),w2d:number(row.w2d),d2d:number(row.d2d),loss:number(row.loss),reimbursement:number(row.reimbursement),invoice:number(row.invoice),paidDrops:number(row.paidDrops),deducted:number(row.deducted),assumed:number(row.assumed),talitaJorge:number(row.talitaJorge),paymentDate:text(row.paymentDate)||null})).filter(row=>row.period)
  const summaryByPeriod=new Map(summaries.map(row=>[row.period,row]))

  try {
    await admin.from('loss_events').delete().not('id', 'is', null)
    await admin.from('financial_payment_history').delete().not('id', 'is', null)
    await admin.from('financial_drop_items').delete().not('id', 'is', null)
    await admin.from('financial_periods').delete().not('id', 'is', null)
    const { error: viewDeleteError } = await admin.from('financial_views').delete().not('id', 'is', null)
    if (viewDeleteError) throw viewDeleteError

    if (drops.length) {
      const { data: existingDrops, error: dropsError } = await admin.from('drops').select('id,name')
      if (dropsError) throw dropsError
      const byName = new Map((existingDrops ?? []).map(drop => [dropKey(drop.name), drop.id]))
      for (const item of drops) {
        const payload = { partner: item.partner || null, monthly_value: item.agreed || null, pix_key: item.pixKey || null, email: item.email || null }
        const id = byName.get(dropKey(item.name))
        const result = id ? await admin.from('drops').update(payload).eq('id', id) : await admin.from('drops').insert({ ...payload, name: item.name, status: 'ATIVO' })
        if (result.error) throw result.error
      }
    }

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
      const periodLosses = losses.filter(row => row.period === label)
      const { data: view, error: viewError } = await admin.from('financial_views').insert({
        title: label, source_file_name: sourceFile, source_rows: periodRows.length + periodLosses.length,
        import_status: 'rascunho', notes: JSON.stringify({ sourceFile, summary: summaryByPeriod.get(label) ?? null }),
      }).select().single()
      if (viewError || !view) throw viewError ?? new Error('Não foi possível criar a View histórica.')
      lastViewId = view.id
      const partnerByDrop = new Map(periodRows.map(row => [dropKey(row.drop), row.partner]))
      const partners = [...new Set([...periodRows.map(row => row.partner), ...periodLosses.map(row => partnerByDrop.get(dropKey(row.drop)) || 'SEM PARCEIRO')])]
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
        const { error: historyError } = await admin.from('financial_payment_history').insert(part.map(row => ({
          financial_period_id: periodId.get(row.partner), period_label: label, partner: row.partner, drop_name_snapshot: row.drop,
          amount: row.agreed, package_quantity: row.quantity, subtotal: row.subtotal,
          loss_amount: row.lossAmount, reimbursement: row.reimbursement, total_receivable: row.receivable,
          pix_key: row.pixKey || null, paid_at: row.paymentDate,
        })))
        if (historyError) throw historyError
      }
      for (const part of chunk(periodLosses)) {
        const { error } = await admin.from('loss_events').insert(part.map(row => {
          const partner = partnerByDrop.get(dropKey(row.drop)) || 'SEM PARCEIRO'
          return { financial_period_id: periodId.get(partner), partner, period_label: label, drop_name_snapshot: row.drop,
            waybill: row.waybill, label_code: row.labelCode, bag_code: row.bagCode, status: row.status, seller: row.seller,
            received_at: row.receivedAt, amount: row.amount, observation: row.observation }
        }))
        if (error) throw error
      }
      if(periodLosses.length){const {count,error}=await admin.from('loss_events').select('id',{count:'exact',head:true}).eq('period_label',label);if(error||!count)throw error??new Error(`Extravios do período ${label} não foram gravados.`)}
      const { error: completeError } = await admin.from('financial_views').update({ import_status: 'importado' }).eq('id', view.id)
      if (completeError) throw completeError
    }
    return res.status(200).json({ views: periodOrder.length, rows: rows.length, losses: losses.length, lastViewId })
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Falha ao reconstruir o histórico.' })
  }
}
