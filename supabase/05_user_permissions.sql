-- Movidos | Controle detalhado de usuários
-- Execute após 04_employees.sql.

create table if not exists public.user_module_permissions (
  user_id uuid primary key references public.user_profiles(id) on delete cascade,
  cadastros_view boolean not null default false,
  cadastros_create boolean not null default false,
  cadastros_edit boolean not null default false,
  cadastros_delete boolean not null default false,
  financeiro_view boolean not null default false,
  financeiro_manage boolean not null default false,
  funcionarios_view boolean not null default false,
  funcionarios_manage boolean not null default false,
  configuracoes_manage boolean not null default false,
  updated_at timestamptz not null default timezone('utc', now())
);

create or replace function public.set_permissions_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = timezone('utc', now()); return new; end;
$$;
drop trigger if exists user_module_permissions_updated_at on public.user_module_permissions;
create trigger user_module_permissions_updated_at before update on public.user_module_permissions
for each row execute function public.set_permissions_updated_at();

-- Mantém o uso atual para contas existentes: operador administra cadastros;
-- financeiro também acessa o Financeiro. Administradores têm acesso total pela função is_admin().
insert into public.user_module_permissions (user_id, cadastros_view, cadastros_create, cadastros_edit, cadastros_delete, financeiro_view, financeiro_manage)
select id, true, true, true, true, role = 'financeiro', role = 'financeiro'
from public.user_profiles
on conflict (user_id) do nothing;

alter table public.user_module_permissions enable row level security;
drop policy if exists "permissions_admin_only" on public.user_module_permissions;
create policy "permissions_admin_only" on public.user_module_permissions for all to authenticated
using (public.is_admin()) with check (public.is_admin());
drop policy if exists "permissions_own_read" on public.user_module_permissions;
create policy "permissions_own_read" on public.user_module_permissions for select to authenticated
using (user_id = auth.uid());

create or replace function public.has_module_permission(permission_name text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare allowed boolean;
begin
  if public.is_admin() then return true; end if;
  execute format('select %I from public.user_module_permissions where user_id = auth.uid()', permission_name) into allowed;
  return coalesce(allowed, false);
end;
$$;

-- As permissões são aplicadas também na base, mesmo se alguém tentar abrir uma rota manualmente.
drop policy if exists "drops_read" on public.drops;
create policy "drops_read" on public.drops for select to authenticated using (public.has_module_permission('cadastros_view'));
drop policy if exists "drops_write" on public.drops;
create policy "drops_insert" on public.drops for insert to authenticated with check (public.has_module_permission('cadastros_create'));
create policy "drops_update" on public.drops for update to authenticated using (public.has_module_permission('cadastros_edit')) with check (public.has_module_permission('cadastros_edit'));
create policy "drops_delete" on public.drops for delete to authenticated using (public.has_module_permission('cadastros_delete'));

drop policy if exists "financial_read" on public.financial_periods;
create policy "financial_read" on public.financial_periods for select to authenticated using (public.has_module_permission('financeiro_view'));
drop policy if exists "financial_write" on public.financial_periods;
create policy "financial_write" on public.financial_periods for all to authenticated using (public.has_module_permission('financeiro_manage')) with check (public.has_module_permission('financeiro_manage'));
drop policy if exists "financial_items_read" on public.financial_drop_items;
create policy "financial_items_read" on public.financial_drop_items for select to authenticated using (public.has_module_permission('financeiro_view'));
drop policy if exists "financial_items_write" on public.financial_drop_items;
create policy "financial_items_write" on public.financial_drop_items for all to authenticated using (public.has_module_permission('financeiro_manage')) with check (public.has_module_permission('financeiro_manage'));
drop policy if exists "losses_read" on public.loss_events;
create policy "losses_read" on public.loss_events for select to authenticated using (public.has_module_permission('financeiro_view'));
drop policy if exists "losses_write" on public.loss_events;
create policy "losses_write" on public.loss_events for all to authenticated using (public.has_module_permission('financeiro_manage')) with check (public.has_module_permission('financeiro_manage'));

drop policy if exists "employees_admin_only" on public.employees;
create policy "employees_read" on public.employees for select to authenticated using (public.has_module_permission('funcionarios_view'));
create policy "employees_write" on public.employees for all to authenticated using (public.has_module_permission('funcionarios_manage')) with check (public.has_module_permission('funcionarios_manage'));
drop policy if exists "employee_dependents_admin_only" on public.employee_dependents;
create policy "employee_dependents_read" on public.employee_dependents for select to authenticated using (public.has_module_permission('funcionarios_view'));
create policy "employee_dependents_write" on public.employee_dependents for all to authenticated using (public.has_module_permission('funcionarios_manage')) with check (public.has_module_permission('funcionarios_manage'));

-- Toda nova conta nasce sem acesso até um administrador configurar seu perfil.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare employee_role text;
begin
  insert into public.user_profiles (id, email, full_name)
  values (new.id, coalesce(new.email, new.id::text || '@invalid.local'), coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  insert into public.user_module_permissions (user_id) values (new.id) on conflict (user_id) do nothing;
  update public.employees set auth_user_id = new.id
  where auth_user_id is null and lower(personal_email::text) = lower(coalesce(new.email, ''))
  returning access_role into employee_role;
  if employee_role is not null then update public.user_profiles set role = employee_role where id = new.id; end if;
  return new;
end;
$$;
