begin;

alter table public.user_module_permissions
  add column if not exists delivery_routes_manage boolean not null default false;

create or replace function public.can_manage_delivery_routes() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_profiles profile
    where profile.id = auth.uid() and profile.is_active
      and (
        profile.role = 'admin'
        or lower(profile.email::text) = 'talitapreviatti@gmail.com'
        or exists (
          select 1 from public.user_module_permissions permissions
          where permissions.user_id = profile.id
            and permissions.delivery_routes_manage is true
        )
      )
  );
$$;

revoke all on function public.can_manage_delivery_routes() from public, anon;
grant execute on function public.can_manage_delivery_routes() to authenticated;

commit;