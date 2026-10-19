begin;

create or replace function public.guard_route_duplicate() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare identity text; old_identity text; postal text;
begin
  if not new.is_active then return new; end if;
  postal := regexp_replace(coalesce(new.postal_code,''),'\D','','g');
  identity := public.route_identity(new.street,new.neighborhood,new.city,new.zone,new.route);
  if tg_op='UPDATE' and old.is_active then
    old_identity := public.route_identity(old.street,old.neighborhood,old.city,old.zone,old.route);
    if identity=old_identity and (postal='' or postal=regexp_replace(coalesce(old.postal_code,''),'\D','','g')) then
      return new;
    end if;
  end if;
  identity := identity || '|' || postal;
  perform pg_advisory_xact_lock(hashtextextended(identity,2));
  if exists (
    select 1 from public.delivery_route_base other
    where other.id<>new.id and other.is_active
      and public.route_identity(other.street,other.neighborhood,other.city,other.zone,other.route)
        || '|' || regexp_replace(coalesce(other.postal_code,''),'\D','','g') = identity
  ) then
    raise exception 'Endereco-base duplicado nesta zona, rota e CEP.' using errcode='23505';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_route_duplicate on public.delivery_route_base;
create trigger guard_route_duplicate before insert or update of street,neighborhood,city,zone,route,postal_code,is_active
on public.delivery_route_base for each row execute function public.guard_route_duplicate();

notify pgrst,'reload schema';
commit;