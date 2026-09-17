import { supabase } from './lib/supabase'
import type { DataRow } from './financialData'

const pending = new Map<string, Promise<DataRow[]>>()
const columns: Record<string, string> = {
  drops: 'id,legacy_id,name,partner,responsible,status,cpf,cnpj,pix_key,pix_holder_name,email,is_active,created_at',
  financial_periods: 'id,label,partner,reference_cnpj,financial_view_id,payment_date,net_amount,status',
  financial_payment_history: 'id,drop_id,financial_period_id,period_label,partner,drop_name_snapshot,responsible,package_quantity,amount,subtotal,loss_amount,reimbursement,total_receivable,paid_at,pix_key,pix_holder_name,cnpj,observation',
  financial_drop_items: 'id,financial_period_id,drop_name_snapshot,quantity_packages,unit_value,reimbursement',
}

export function readFinancialRows(table: string) {
  const existing = pending.get(table)
  if (existing) return existing
  const request = readRows(table)
  pending.set(table, request)
  void request.finally(() => { if (pending.get(table) === request) pending.delete(table) }).catch(() => {})
  return request
}

async function readRows(table: string) {
  if (!supabase) return []
  const rows: DataRow[] = []
  for (let from = 0; ; from += 1000) {
    let query = supabase.from(table).select(columns[table] ?? '*')
    if (['drops', 'financial_views', 'financial_periods', 'financial_drop_items', 'financial_payment_history', 'loss_events'].includes(table)) query = query.eq('is_active', true)
    const { data, error } = await query.order('id').range(from, from + 999)
    if (error) throw error
    rows.push(...(data ?? []))
    if ((data ?? []).length < 1000) return rows
  }
}
