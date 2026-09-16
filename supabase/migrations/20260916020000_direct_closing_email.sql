begin;
alter table public.email_logs add column if not exists delivery_key text;
create unique index if not exists email_logs_delivery_key_unique on public.email_logs (delivery_key) where delivery_key is not null;
alter table public.email_logs drop constraint if exists email_logs_status_check;
alter table public.email_logs add constraint email_logs_status_check check (status in ('enviado','preparado','erro','enviando','aceito','incerto'));
drop policy if exists "email_logs_admin" on public.email_logs;
drop policy if exists "email_logs_insert" on public.email_logs;
create policy "email_logs_insert" on public.email_logs for insert to authenticated
with check (public.is_active_user() and public.has_module_permission('financeiro_manage') and delivery_key is null and status in ('preparado','erro'));
commit;