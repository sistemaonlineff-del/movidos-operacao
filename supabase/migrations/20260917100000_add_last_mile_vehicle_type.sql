begin;

alter table public.drops add column if not exists vehicle_type text;

notify pgrst, 'reload schema';

commit;