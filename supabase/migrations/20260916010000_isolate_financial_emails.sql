begin;

drop policy if exists "email_templates_read" on public.email_templates;
drop policy if exists "email_templates_write" on public.email_templates;
drop policy if exists "email_templates_admin_write" on public.email_templates;

create policy "email_templates_read" on public.email_templates for select to authenticated
using (public.is_active_user() and (
  key like 'ready-message-%' or public.has_module_permission('financeiro_view')
));

create policy "email_templates_write" on public.email_templates for all to authenticated
using (public.is_active_user() and (
  (key like 'ready-message-%' and public.is_admin()) or
  (key not like 'ready-message-%' and public.has_module_permission('financeiro_manage'))
))
with check (public.is_active_user() and (
  (key like 'ready-message-%' and public.is_admin()) or
  (key not like 'ready-message-%' and public.has_module_permission('financeiro_manage'))
));

drop policy if exists "email_logs_admin" on public.email_logs;
drop policy if exists "email_logs_read" on public.email_logs;
drop policy if exists "email_logs_insert" on public.email_logs;
create policy "email_logs_read" on public.email_logs for select to authenticated
using (public.is_active_user() and public.has_module_permission('financeiro_view'));
create policy "email_logs_insert" on public.email_logs for insert to authenticated
with check (public.is_active_user() and public.has_module_permission('financeiro_manage'));

drop policy if exists "app_notes_read" on public.app_notes;
drop policy if exists "app_notes_write" on public.app_notes;
create policy "app_notes_read" on public.app_notes for select to authenticated
using (public.is_active_user() and (key <> 'financial' or public.has_module_permission('financeiro_view')));
create policy "app_notes_write" on public.app_notes for all to authenticated
using (public.is_active_user() and (key <> 'financial' or public.has_module_permission('financeiro_manage')))
with check (public.is_active_user() and (key <> 'financial' or public.has_module_permission('financeiro_manage')));

commit;