select view_row.id, view_row.title, view_row.is_active,
  count(period.id) as linked_periods,
  array_agg(distinct period.label) filter (where period.id is not null) as period_labels,
  array_agg(distinct coalesce(period.logistics_partner, period.partner)) filter (where period.id is not null) as partners,
  array_agg(distinct coalesce(period.reference_cnpj, 'MOVIDOS')) filter (where period.id is not null) as companies
from public.financial_views view_row
left join public.financial_periods period on period.financial_view_id = view_row.id
where upper(trim(view_row.title)) in (
  '35. 1Q DE SETEMBRO', '35. 2Q DE SETEMBRO', '36. 2Q DE SETEMBRO'
)
group by view_row.id, view_row.title, view_row.is_active
order by view_row.title, view_row.id;