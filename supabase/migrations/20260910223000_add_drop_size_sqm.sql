alter table public.drops
  add column if not exists size_sqm numeric(10,2);
