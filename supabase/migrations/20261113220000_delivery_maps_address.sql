begin;

alter table public.delivery_volumes
  add column if not exists maps_address text;

notify pgrst, 'reload schema';

commit;