import { readFinancialRows } from '../financialStore';
import { buildDetails, buildTotals, notes } from '../financialData';
import { supabase } from '../lib/supabase';
import { closingSources } from './closing';

export async function loadClosingSources(allowed: boolean) {
  if (!allowed) throw new Error('Permissao de consulta ao Financeiro necessaria.');
  if (!supabase) throw new Error('Supabase indisponivel.');
  const [views, periods, items, losses, history, drops] = await Promise.all(['financial_views', 'financial_periods', 'financial_drop_items', 'loss_events', 'financial_payment_history', 'drops'].map(readFinancialRows));
  const enriched = views.map(view => {
    const metadata = notes(typeof view.notes === 'string' ? view.notes : JSON.stringify(view.notes ?? {}));
    if (metadata.summary?.talitaJorge !== null && metadata.summary?.talitaJorge !== undefined && metadata.summary?.talitaJorge !== '') return view;
    const linked = periods.filter(period => period.financial_view_id === view.id);
    const ids = new Set(linked.map(period => period.id));
    const selectedLosses = losses.filter(row => ids.has(row.financial_period_id));
    const details = buildDetails(history.filter(row => ids.has(row.financial_period_id)), items.filter(row => ids.has(row.financial_period_id)), selectedLosses, linked, drops);
    const totals = buildTotals(details, selectedLosses, linked, [view]);
    if (!totals.length || totals.some(row => row.net === null)) return view;
    const result = Math.round(totals.reduce((sum, row) => sum + Number(row.net), 0) * 100) - Math.round(details.reduce((sum, row) => sum + Number(row.receivable), 0) * 100);
    return { ...view, closingDerived: true, notes: { ...metadata, summary: { ...metadata.summary, talitaJorge: (result / 100).toFixed(2) } } };
  });
  return closingSources(enriched, periods);
}