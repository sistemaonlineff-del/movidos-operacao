begin;

alter table public.delivery_volumes
  add column if not exists scan_key text;

create unique index if not exists delivery_volumes_scan_key_key
  on public.delivery_volumes (scan_key);

notify pgrst, 'reload schema';

commit;