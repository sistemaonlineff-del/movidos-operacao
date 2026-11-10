begin;
drop function if exists public.public_active_drops();
create function public.public_active_drops()
returns table(id uuid,name text,address text,address_number text,neighborhood text,municipality text,state text,postal_code text,latitude numeric,longitude numeric,phone text)
language sql stable security definer set search_path=pg_catalog,public as $$
  select d.id,d.name::text,d.address::text,d.address_number::text,d.neighborhood::text,d.municipality::text,d.state::text,d.postal_code::text,d.latitude,d.longitude,nullif(btrim(d.phone::text),'')
  from public.drops d
  where d.status='ATIVO' and d.is_active=true and d.registration_type='drop_off'
    and d.latitude between -35 and 6 and d.longitude between -75 and -32
  order by d.id
$$;
revoke all on function public.public_active_drops() from public;
grant execute on function public.public_active_drops() to anon,authenticated;
commit;