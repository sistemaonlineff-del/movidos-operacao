begin;
alter table public.drops add column if not exists operation_started_at date;
alter table public.drops add column if not exists operation_ended_at date;
alter table public.drops drop constraint if exists drops_operation_dates_check;
alter table public.drops add constraint drops_operation_dates_check check (operation_started_at is null or operation_ended_at is null or operation_ended_at >= operation_started_at) not valid;

create or replace function public.registration_identity(value text) returns text language sql immutable set search_path=public,pg_temp as $$
  select regexp_replace(translate(upper(trim(coalesce(value,''))),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC'),'\s+',' ','g');
$$;
create or replace function public.guard_drop_duplicate() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare identity text;
begin
  if not new.is_active then return new; end if;
  identity:=public.registration_identity(new.name)||'|'||public.registration_identity(new.partner)||'|'||public.registration_identity(new.municipality)||'|'||coalesce(new.registration_type,'drop_off');
  if tg_op='UPDATE' and identity=public.registration_identity(old.name)||'|'||public.registration_identity(old.partner)||'|'||public.registration_identity(old.municipality)||'|'||coalesce(old.registration_type,'drop_off') and old.is_active then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(identity,1));
  if exists(select 1 from public.drops other where other.id<>new.id and other.is_active and public.registration_identity(other.name)=public.registration_identity(new.name) and public.registration_identity(other.partner)=public.registration_identity(new.partner) and public.registration_identity(other.municipality)=public.registration_identity(new.municipality) and coalesce(other.registration_type,'drop_off')=coalesce(new.registration_type,'drop_off')) then raise exception 'Cadastro duplicado: mesmo nome, parceiro, municipio e tipo. Edite o cadastro existente.' using errcode='23505'; end if;
  return new;
end;
$$;
drop trigger if exists guard_drop_duplicate on public.drops;
create trigger guard_drop_duplicate before insert or update of name,partner,municipality,registration_type,is_active on public.drops for each row execute function public.guard_drop_duplicate();

create or replace function public.route_identity(street text, neighborhood text, city text, zone text, route text) returns text language sql immutable set search_path=public,pg_temp as $$
  select public.registration_identity(street)||'|'||public.registration_identity(neighborhood)||'|'||public.registration_identity(city)||'|'||public.registration_identity(zone)||'|'||public.registration_identity(route);
$$;
create or replace function public.guard_route_duplicate() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare identity text;
begin
  if not new.is_active then return new; end if;
  identity:=public.route_identity(new.street,new.neighborhood,new.city,new.zone,new.route);
  if tg_op='UPDATE' and old.is_active and identity=public.route_identity(old.street,old.neighborhood,old.city,old.zone,old.route) then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(identity,2));
  if exists(select 1 from public.delivery_route_base other where other.id<>new.id and other.is_active and public.route_identity(other.street,other.neighborhood,other.city,other.zone,other.route)=identity) then raise exception 'Endereco-base duplicado nesta zona e rota.' using errcode='23505'; end if;
  return new;
end;
$$;
drop trigger if exists guard_route_duplicate on public.delivery_route_base;
create trigger guard_route_duplicate before insert or update of street,neighborhood,city,zone,route,is_active on public.delivery_route_base for each row execute function public.guard_route_duplicate();

create table if not exists public.route_postal_changes(id uuid primary key default gen_random_uuid(),reason text not null,previous_values jsonb not null,created_by uuid references public.user_profiles(id),created_at timestamptz not null default now());
alter table public.route_postal_changes enable row level security;
drop policy if exists route_postal_changes_read on public.route_postal_changes;
create policy route_postal_changes_read on public.route_postal_changes for select to authenticated using(public.can_manage_delivery_routes());
grant select on public.route_postal_changes to authenticated;
create or replace function public.clear_route_postal_codes(route_ids uuid[], reason text) returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare previous jsonb; changed integer;
begin
  if auth.uid() is null or public.can_manage_delivery_routes() is not true then raise exception 'Sem permissao para gerenciar rotas.' using errcode='42501'; end if;
  if route_ids is null or cardinality(route_ids) not between 1 and 10000 or length(trim(coalesce(reason,'')))<5 then raise exception 'Selecione rotas e informe um motivo.'; end if;
  perform id from public.delivery_route_base where id=any(route_ids) order by id for update;
  select jsonb_agg(jsonb_build_object('id',id,'postal_code',postal_code)) into previous from public.delivery_route_base where id=any(route_ids) and is_active and nullif(trim(postal_code),'') is not null;
  if previous is null then return 0; end if;
  update public.delivery_route_base set postal_code=null where id=any(route_ids) and is_active and nullif(trim(postal_code),'') is not null;
  get diagnostics changed = row_count;
  insert into public.route_postal_changes(reason,previous_values,created_by) values(trim(reason),previous,auth.uid());
  return changed;
end;
$$;
revoke all on function public.clear_route_postal_codes(uuid[],text) from public, anon;
grant execute on function public.clear_route_postal_codes(uuid[],text) to authenticated;
notify pgrst,'reload schema';
commit;