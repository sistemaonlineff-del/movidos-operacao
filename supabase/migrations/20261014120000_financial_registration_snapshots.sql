begin;

alter table public.financial_drop_items
  add column if not exists registration_snapshot jsonb;

notify pgrst, 'reload schema';

commit;