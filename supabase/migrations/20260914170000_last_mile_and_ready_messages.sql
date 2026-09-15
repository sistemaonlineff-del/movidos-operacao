-- Cadastro Last Mile usa a mesma base de pessoas/empresas, sem misturar com Drop off.
alter table public.drops add column if not exists registration_type text not null default 'drop_off'
  check (registration_type in ('drop_off', 'last_mile'));
alter table public.drops add column if not exists weekly_package_value numeric(14,2);
alter table public.drops add column if not exists sunday_holiday_package_value numeric(14,2);
alter table public.drops add column if not exists pix_key_type text;
alter table public.drops add column if not exists vehicle_plate text;
alter table public.drops add column if not exists delivery_cities text;
alter table public.drops add column if not exists work_days text;
create index if not exists idx_drops_registration_type on public.drops (registration_type);

-- Mensagens podem ser lidas por usuários ativos; criação, edição e exclusão ficam com administrador.
drop policy if exists "email_templates_write" on public.email_templates;
create policy "email_templates_admin_write" on public.email_templates for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
