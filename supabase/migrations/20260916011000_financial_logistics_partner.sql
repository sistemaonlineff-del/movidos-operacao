begin;

alter table public.financial_periods add column if not exists logistics_partner text;
alter table public.financial_periods add column if not exists responsible text;
alter table public.financial_payment_history add column if not exists logistics_partner text;
alter table public.loss_events add column if not exists logistics_partner text;

update public.financial_periods
set responsible = coalesce(nullif(responsible, ''), case
  when partner !~* 'imile|j[[:space:]]*&[[:space:]]*t' then partner end),
  logistics_partner = 'IMILE DELIVERY BRAZIL LTDA'
where logistics_partner is null;

update public.financial_payment_history
set responsible = coalesce(nullif(responsible, ''), case
  when partner !~* 'imile|j[[:space:]]*&[[:space:]]*t' then partner end),
  logistics_partner = 'IMILE DELIVERY BRAZIL LTDA'
where logistics_partner is null;

update public.loss_events
set logistics_partner = 'IMILE DELIVERY BRAZIL LTDA'
where logistics_partner is null;

update public.financial_periods set reference_cnpj = 'MOVIDOS' where reference_cnpj is distinct from 'MOVIDOS';
alter table public.financial_periods alter column reference_cnpj set default 'MOVIDOS';

commit;