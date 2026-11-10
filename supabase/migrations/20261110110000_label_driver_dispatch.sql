begin;
alter table public.user_module_permissions add column if not exists label_reader_access boolean not null default false;
alter table public.user_module_permissions alter column label_reader_access set default false;
alter table public.delivery_volumes add column if not exists driver_id uuid references public.user_profiles(id);
alter table public.delivery_volumes add column if not exists recipient_address text;
alter table public.delivery_volumes add column if not exists address_confirmed boolean not null default false;
create index if not exists delivery_volumes_driver_day on public.delivery_volumes(delivery_date,driver_id,created_at,id);
create or replace function public.can_read_own_label_volumes() returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.user_profiles p where p.id=auth.uid() and p.is_active
    and (p.role='admin' or exists(select 1 from public.user_module_permissions m where m.user_id=p.id and m.label_reader_access)))
$$;
revoke all on function public.can_read_own_label_volumes() from public;
grant execute on function public.can_read_own_label_volumes() to authenticated;
grant select on public.delivery_volumes to authenticated;
drop policy if exists delivery_volumes_own_labels on public.delivery_volumes;
create policy delivery_volumes_own_labels on public.delivery_volumes for select to authenticated
  using(driver_id=auth.uid() and public.can_read_own_label_volumes());
commit;