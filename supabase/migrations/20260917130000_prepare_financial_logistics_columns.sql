begin;

alter table public.financial_periods add column if not exists logistics_partner text;
alter table public.financial_periods add column if not exists responsible text;
alter table public.financial_payment_history add column if not exists logistics_partner text;
alter table public.loss_events add column if not exists logistics_partner text;

notify pgrst, 'reload schema';

commit;