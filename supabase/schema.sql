-- Movidos: execute this file once in Supabase SQL Editor before publishing.
-- This schema replaces the Access tables with typed, audited PostgreSQL data.

create extension if not exists pgcrypto;
create extension if not exists citext;

create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email citext not null unique,
  role text not null default 'operador' check (role in ('admin', 'operador', 'financeiro')),
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.drops (
  id uuid primary key default gen_random_uuid(),
  legacy_id bigint unique,
  name text not null,
  partner text,
  responsible text,
  status text not null default 'INTERESSADO' check (status in ('INTERESSADO','PICKUP - INTERESSADO','AG. ASSINATURA','CONTRATO ASSINADO','ENVIADO - AG. APROVAÇÃO','ATIVO','ATIVO - AG. LOGIN','ATIVO - AG. INSUMOS','CONGELADO','PROBLEMA','EXCLUÍDO')),
  cpf text, cnpj text, state_registration text,
  phone text, alternate_phone text, email citext,
  zone text, municipality text, state text, neighborhood text, address text, address_number text, complement text, postal_code text,
  legal_name text, trade_name text,
  company_address text, company_address_number text, company_complement text,
  company_neighborhood text, company_postal_code text, company_municipality text, company_state text,
  latitude numeric(10,7), longitude numeric(10,7),
  pix_key text, pix_holder_name text,
  weekday_opening_time text, weekday_closing_time text, saturday_opening_time text, saturday_closing_time text,
  weekday_scan_time text, saturday_scan_time text,
  monthly_value numeric(14,2), start_period text, end_period text,
  notes text, termination_reason text, signed_at date, terminated_at date,
  created_by uuid references public.user_profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.financial_periods (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  partner text not null,
  payment_date date,
  net_amount numeric(14,2),
  status text not null default 'aberto' check (status in ('aberto','congelado','pago')),
  created_by uuid references public.user_profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
  , unique(label, partner)
);

create table if not exists public.financial_drop_items (
  id uuid primary key default gen_random_uuid(),
  legacy_id bigint unique,
  financial_period_id uuid not null references public.financial_periods(id) on delete cascade,
  drop_id uuid references public.drops(id) on delete set null,
  drop_name_snapshot text not null,
  quantity_packages integer not null default 0 check (quantity_packages >= 0),
  reimbursement numeric(14,2) not null default 0,
  unit_value numeric(14,2) not null default 0,
  total_amount numeric(14,2) generated always as ((quantity_packages * unit_value) + reimbursement) stored,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.loss_events (
  id uuid primary key default gen_random_uuid(),
  legacy_id bigint unique,
  financial_period_id uuid references public.financial_periods(id) on delete set null,
  drop_id uuid references public.drops(id) on delete set null,
  partner text, period_label text, drop_name_snapshot text,
  waybill text, label_code text, bag_code text, seller text,
  received_at timestamptz, status text, observation text,
  amount numeric(14,2) not null default 0,
  created_by uuid references public.user_profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.drop_documents (
  id uuid primary key default gen_random_uuid(),
  drop_id uuid not null references public.drops(id) on delete cascade,
  kind text not null check (kind in ('foto','contrato','distrato','outro')),
  file_name text not null, storage_path text not null unique, mime_type text,
  uploaded_by uuid references public.user_profiles(id),
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.email_logs (
  id uuid primary key default gen_random_uuid(),
  legacy_id bigint unique,
  financial_period_id uuid references public.financial_periods(id) on delete set null,
  drop_id uuid references public.drops(id) on delete set null,
  recipient_email citext, status text not null check (status in ('enviado','erro')),
  error_message text, sent_at timestamptz not null default timezone('utc', now()),
  created_by uuid references public.user_profiles(id)
);

create table if not exists public.financial_payment_history (
  id uuid primary key default gen_random_uuid(),
  legacy_id bigint unique,
  financial_period_id uuid references public.financial_periods(id) on delete set null,
  drop_id uuid references public.drops(id) on delete set null,
  period_label text, partner text, drop_name_snapshot text, responsible text,
  amount numeric(14,2), package_quantity integer, subtotal numeric(14,2), loss_amount numeric(14,2), reimbursement numeric(14,2), total_receivable numeric(14,2),
  pix_key text, pix_holder_name text, email citext, observation text,
  frozen_at timestamptz, paid_at timestamptz, cnpj text,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(), user_id uuid references public.user_profiles(id),
  action text not null, entity_type text not null, entity_id uuid, details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

-- Valores das listas configuráveis (parceiro, zona, horários, etc.).
create table if not exists public.lookup_values (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  value text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique(category, value)
);

create index if not exists idx_drops_search on public.drops (status, partner, municipality);
create index if not exists idx_financial_items_period on public.financial_drop_items (financial_period_id);
create index if not exists idx_losses_period on public.loss_events (financial_period_id);
create index if not exists idx_payment_history_period on public.financial_payment_history (financial_period_id);
create index if not exists idx_lookup_values_category on public.lookup_values (category, is_active, sort_order);

create or replace function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = timezone('utc', now()); return new; end; $$;
drop trigger if exists user_profiles_updated_at on public.user_profiles; create trigger user_profiles_updated_at before update on public.user_profiles for each row execute function public.set_updated_at();
drop trigger if exists drops_updated_at on public.drops; create trigger drops_updated_at before update on public.drops for each row execute function public.set_updated_at();
drop trigger if exists financial_periods_updated_at on public.financial_periods; create trigger financial_periods_updated_at before update on public.financial_periods for each row execute function public.set_updated_at();
drop trigger if exists financial_drop_items_updated_at on public.financial_drop_items; create trigger financial_drop_items_updated_at before update on public.financial_drop_items for each row execute function public.set_updated_at();
drop trigger if exists loss_events_updated_at on public.loss_events; create trigger loss_events_updated_at before update on public.loss_events for each row execute function public.set_updated_at();
drop trigger if exists lookup_values_updated_at on public.lookup_values; create trigger lookup_values_updated_at before update on public.lookup_values for each row execute function public.set_updated_at();

create or replace function public.is_active_user() returns boolean language sql stable security definer set search_path = public as $$ select exists(select 1 from public.user_profiles where id=auth.uid() and is_active); $$;
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$ select exists(select 1 from public.user_profiles where id=auth.uid() and is_active and role='admin'); $$;

-- Cada conta criada por e-mail recebe perfil de operador.
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_profiles (id, email, full_name)
  values (new.id, coalesce(new.email, new.id::text || '@invalid.local'), coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

alter table public.user_profiles enable row level security;
alter table public.drops enable row level security;
alter table public.financial_periods enable row level security;
alter table public.financial_drop_items enable row level security;
alter table public.loss_events enable row level security;
alter table public.drop_documents enable row level security;
alter table public.email_logs enable row level security;
alter table public.financial_payment_history enable row level security;
alter table public.audit_logs enable row level security;
alter table public.lookup_values enable row level security;

create policy "profiles_read" on public.user_profiles for select to authenticated using (public.is_active_user());
create policy "profiles_admin" on public.user_profiles for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "drops_read" on public.drops for select to authenticated using (public.is_active_user());
create policy "drops_write" on public.drops for all to authenticated using (public.is_active_user()) with check (public.is_active_user());
create policy "financial_read" on public.financial_periods for select to authenticated using (public.is_active_user());
create policy "financial_write" on public.financial_periods for all to authenticated using (public.is_admin() or exists(select 1 from public.user_profiles where id=auth.uid() and role='financeiro' and is_active)) with check (public.is_admin() or exists(select 1 from public.user_profiles where id=auth.uid() and role='financeiro' and is_active));
create policy "financial_items_read" on public.financial_drop_items for select to authenticated using (public.is_active_user());
create policy "financial_items_write" on public.financial_drop_items for all to authenticated using (public.is_admin() or exists(select 1 from public.user_profiles where id=auth.uid() and role='financeiro' and is_active)) with check (public.is_admin() or exists(select 1 from public.user_profiles where id=auth.uid() and role='financeiro' and is_active));
create policy "losses_read" on public.loss_events for select to authenticated using (public.is_active_user());
create policy "losses_write" on public.loss_events for all to authenticated using (public.is_active_user()) with check (public.is_active_user());
create policy "documents_access" on public.drop_documents for all to authenticated using (public.is_active_user()) with check (public.is_active_user());
create policy "email_logs_admin" on public.email_logs for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "payment_history_read" on public.financial_payment_history for select to authenticated using (public.is_active_user());
create policy "payment_history_write" on public.financial_payment_history for all to authenticated using (public.is_admin() or exists(select 1 from public.user_profiles where id=auth.uid() and role='financeiro' and is_active)) with check (public.is_admin() or exists(select 1 from public.user_profiles where id=auth.uid() and role='financeiro' and is_active));
create policy "audit_read" on public.audit_logs for select to authenticated using (public.is_admin());
create policy "audit_insert" on public.audit_logs for insert to authenticated with check (user_id=auth.uid());
create policy "lookup_read" on public.lookup_values for select to authenticated using (public.is_active_user());
create policy "lookup_write" on public.lookup_values for all to authenticated using (public.is_admin()) with check (public.is_admin());

insert into storage.buckets (id,name,public) values ('movidos-documents','movidos-documents',false) on conflict (id) do nothing;
create policy "documents_storage_read" on storage.objects for select to authenticated using (bucket_id='movidos-documents' and public.is_active_user());
create policy "documents_storage_write" on storage.objects for insert to authenticated with check (bucket_id='movidos-documents' and public.is_active_user());
create policy "documents_storage_delete" on storage.objects for delete to authenticated using (bucket_id='movidos-documents' and (owner_id=auth.uid()::text or public.is_admin()));

insert into public.lookup_values (category, value, sort_order) values
  ('status_drop', 'INTERESSADO', 1), ('status_drop', 'AG. ASSINATURA', 2), ('status_drop', 'CONTRATO ASSINADO', 3),
  ('status_drop', 'PICKUP - INTERESSADO', 2), ('status_drop', 'ENVIADO - AG. APROVAÇÃO', 5), ('status_drop', 'ATIVO', 6), ('status_drop', 'ATIVO - AG. LOGIN', 7),
  ('status_drop', 'ATIVO - AG. INSUMOS', 8), ('status_drop', 'CONGELADO', 9), ('status_drop', 'PROBLEMA', 10), ('status_drop', 'EXCLUÍDO', 11),
  ('zona', 'NORTE', 1), ('zona', 'SUL', 2), ('zona', 'LESTE', 3), ('zona', 'OESTE', 4), ('zona', 'CENTRO', 5),
  ('tipo_chave_pix', 'CPF', 1), ('tipo_chave_pix', 'CNPJ', 2), ('tipo_chave_pix', 'E-mail', 3), ('tipo_chave_pix', 'Telefone', 4), ('tipo_chave_pix', 'Aleatória', 5)
on conflict (category, value) do nothing;
