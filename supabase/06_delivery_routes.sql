-- Movidos | Base de endereços e pré-rotas de entrega.
-- Execute este arquivo uma vez no SQL Editor do Supabase.

-- Libera o leitor para todas as contas existentes e deixa o controle disponível em Configurações.
alter table public.user_module_permissions add column if not exists label_reader_access boolean not null default true;
update public.user_module_permissions set label_reader_access = true;

create table if not exists public.delivery_route_base (
  id uuid primary key default gen_random_uuid(),
  street text,
  neighborhood text,
  city text,
  postal_code text,
  zone text not null,
  route text not null default 'A definir',
  latitude numeric(10, 7),
  longitude numeric(10, 7),
  delivery_sequence integer check (delivery_sequence is null or delivery_sequence > 0),
  is_active boolean not null default true,
  created_by uuid references public.user_profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- Mantém compatibilidade caso a versão inicial deste arquivo já tenha sido executada.
alter table public.delivery_route_base add column if not exists latitude numeric(10, 7);
alter table public.delivery_route_base add column if not exists longitude numeric(10, 7);
alter table public.delivery_route_base add column if not exists delivery_sequence integer check (delivery_sequence is null or delivery_sequence > 0);
alter table public.delivery_route_base alter column route set default 'A definir';

create table if not exists public.delivery_volumes (
  id uuid primary key default gen_random_uuid(),
  delivery_date date not null default current_date,
  zone text not null,
  route text not null,
  batch_number integer not null default 1 check (batch_number > 0),
  driver_name text,
  recipient text,
  street text,
  neighborhood text,
  city text,
  postal_code text,
  delivery_sequence integer check (delivery_sequence is null or delivery_sequence > 0),
  scan_key text unique,
  created_by uuid references public.user_profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.delivery_volumes add column if not exists scan_key text unique;
alter table public.delivery_volumes add column if not exists delivery_sequence integer check (delivery_sequence is null or delivery_sequence > 0);

create index if not exists idx_delivery_route_base_lookup on public.delivery_route_base (postal_code, city, neighborhood);
create index if not exists idx_delivery_volumes_plan on public.delivery_volumes (delivery_date, zone, route, batch_number);
create index if not exists idx_delivery_route_base_sequence on public.delivery_route_base (zone, route, delivery_sequence);
create index if not exists idx_delivery_volumes_sequence on public.delivery_volumes (delivery_date, zone, route, batch_number, delivery_sequence);

drop trigger if exists delivery_route_base_updated_at on public.delivery_route_base;
create trigger delivery_route_base_updated_at before update on public.delivery_route_base for each row execute function public.set_updated_at();
drop trigger if exists delivery_volumes_updated_at on public.delivery_volumes;
create trigger delivery_volumes_updated_at before update on public.delivery_volumes for each row execute function public.set_updated_at();

-- Nenhum lote de rota ou motorista pode ultrapassar 100 volumes no mesmo dia.
create or replace function public.check_delivery_capacity() returns trigger language plpgsql as $$
begin
  if (select count(*) from public.delivery_volumes where delivery_date = new.delivery_date and zone = new.zone and route = new.route and batch_number = new.batch_number and id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid)) >= 100 then
    raise exception 'Este lote de rota já possui 100 volumes.';
  end if;
  if new.driver_name is not null and btrim(new.driver_name) <> '' and (select count(*) from public.delivery_volumes where delivery_date = new.delivery_date and lower(coalesce(driver_name, '')) = lower(btrim(new.driver_name)) and id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid)) >= 100 then
    raise exception 'Este motorista já possui 100 volumes neste dia.';
  end if;
  return new;
end;
$$;
drop trigger if exists delivery_volumes_capacity on public.delivery_volumes;
create trigger delivery_volumes_capacity before insert or update on public.delivery_volumes for each row execute function public.check_delivery_capacity();

create or replace function public.can_manage_delivery_routes() returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_profiles
    where id = auth.uid() and is_active and (role = 'admin' or lower(email::text) = 'talitapreviatti@gmail.com')
  );
$$;

alter table public.delivery_route_base enable row level security;
alter table public.delivery_volumes enable row level security;
drop policy if exists "delivery_route_base_manage" on public.delivery_route_base;
create policy "delivery_route_base_manage" on public.delivery_route_base for all to authenticated using (public.can_manage_delivery_routes()) with check (public.can_manage_delivery_routes());
drop policy if exists "delivery_volumes_manage" on public.delivery_volumes;
create policy "delivery_volumes_manage" on public.delivery_volumes for all to authenticated using (public.can_manage_delivery_routes()) with check (public.can_manage_delivery_routes());
