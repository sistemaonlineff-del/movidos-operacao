begin;

alter table public.delivery_volumes
  add column if not exists capture_number integer check (capture_number > 0);

notify pgrst, 'reload schema';

commit;