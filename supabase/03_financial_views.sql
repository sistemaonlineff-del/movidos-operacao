-- Execute uma vez no SQL Editor do Supabase.
-- Cada upload quinzenal cria uma View financeira independente.

create table if not exists public.financial_views (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  source_file_name text not null,
  source_rows integer not null default 0 check (source_rows >= 0),
  import_status text not null default 'rascunho' check (import_status in ('rascunho','importado','arquivado')),
  notes text,
  created_by uuid references public.user_profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.financial_periods add column if not exists financial_view_id uuid references public.financial_views(id) on delete cascade;
alter table public.financial_periods drop constraint if exists financial_periods_label_partner_key;
create unique index if not exists financial_periods_view_label_partner_key on public.financial_periods(financial_view_id, label, partner) nulls not distinct;
create index if not exists idx_financial_periods_view on public.financial_periods(financial_view_id);

drop trigger if exists financial_views_updated_at on public.financial_views;
create trigger financial_views_updated_at before update on public.financial_views for each row execute function public.set_updated_at();

alter table public.financial_views enable row level security;
drop policy if exists "financial_views_read" on public.financial_views;
drop policy if exists "financial_views_write" on public.financial_views;
create policy "financial_views_read" on public.financial_views for select to authenticated using (public.is_active_user());
create policy "financial_views_write" on public.financial_views for all to authenticated using (public.is_active_user()) with check (public.is_active_user());
