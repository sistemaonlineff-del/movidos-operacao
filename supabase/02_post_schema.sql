-- Execute este complemento UMA vez, depois do schema.sql já executado.
-- Ajusta os dados legados que não existiam no primeiro modelo.

alter table public.drops drop constraint if exists drops_status_check;
alter table public.drops add constraint drops_status_check check (status in ('INTERESSADO','PICKUP - INTERESSADO','AG. ASSINATURA','CONTRATO ASSINADO','ENVIADO - AG. APROVAÇÃO','ATIVO','ATIVO - AG. LOGIN','ATIVO - AG. INSUMOS','CONGELADO','PROBLEMA','EXCLUÍDO'));

alter table public.financial_periods drop constraint if exists financial_periods_label_key;
alter table public.financial_periods drop constraint if exists financial_periods_label_partner_key;
alter table public.financial_periods add constraint financial_periods_label_partner_key unique (label, partner);

alter table public.financial_drop_items drop constraint if exists financial_drop_items_financial_period_id_drop_name_snapshot_key;

alter table public.financial_drop_items add column if not exists legacy_id bigint unique;
alter table public.loss_events add column if not exists legacy_id bigint unique;
alter table public.email_logs add column if not exists legacy_id bigint unique;

create table if not exists public.financial_payment_history (
  id uuid primary key default gen_random_uuid(), legacy_id bigint unique,
  financial_period_id uuid references public.financial_periods(id) on delete set null,
  drop_id uuid references public.drops(id) on delete set null,
  period_label text, partner text, drop_name_snapshot text, responsible text,
  amount numeric(14,2), package_quantity integer, subtotal numeric(14,2), loss_amount numeric(14,2), reimbursement numeric(14,2), total_receivable numeric(14,2),
  pix_key text, pix_holder_name text, email citext, observation text,
  frozen_at timestamptz, paid_at timestamptz, cnpj text,
  created_at timestamptz not null default timezone('utc', now())
);
alter table public.financial_payment_history enable row level security;
create index if not exists idx_payment_history_period on public.financial_payment_history (financial_period_id);
drop policy if exists "payment_history_read" on public.financial_payment_history;
drop policy if exists "payment_history_write" on public.financial_payment_history;
create policy "payment_history_read" on public.financial_payment_history for select to authenticated using (public.is_active_user());
create policy "payment_history_write" on public.financial_payment_history for all to authenticated using (public.is_admin() or exists(select 1 from public.user_profiles where id=auth.uid() and role='financeiro' and is_active)) with check (public.is_admin() or exists(select 1 from public.user_profiles where id=auth.uid() and role='financeiro' and is_active));

insert into public.lookup_values (category, value, sort_order) values ('status_drop', 'PICKUP - INTERESSADO', 2) on conflict (category, value) do nothing;
