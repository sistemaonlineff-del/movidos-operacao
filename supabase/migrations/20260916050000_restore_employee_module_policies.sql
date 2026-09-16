begin;

do $migration$
begin
  if to_regprocedure('public.is_active_user()') is null
     or to_regprocedure('public.has_module_permission(text)') is null then
    raise exception 'As funcoes is_active_user() e has_module_permission(text) devem existir antes de restaurar as politicas de funcionarios.';
  end if;
end;
$migration$;

alter table public.employees enable row level security;
alter table public.employee_dependents enable row level security;

drop policy if exists "employees_admin_only" on public.employees;
drop policy if exists "employees_read" on public.employees;
drop policy if exists "employees_write" on public.employees;
drop policy if exists "employees_insert" on public.employees;
drop policy if exists "employees_update" on public.employees;

create policy "employees_read" on public.employees for select to authenticated
using (public.is_active_user() and (
  public.has_module_permission('funcionarios_view') or public.has_module_permission('funcionarios_manage')
));
create policy "employees_insert" on public.employees for insert to authenticated
with check (public.is_active_user() and public.has_module_permission('funcionarios_manage'));
create policy "employees_update" on public.employees for update to authenticated
using (public.is_active_user() and public.has_module_permission('funcionarios_manage'))
with check (public.is_active_user() and public.has_module_permission('funcionarios_manage'));

drop policy if exists "employee_dependents_admin_only" on public.employee_dependents;
drop policy if exists "employee_dependents_read" on public.employee_dependents;
drop policy if exists "employee_dependents_write" on public.employee_dependents;
drop policy if exists "employee_dependents_insert" on public.employee_dependents;
drop policy if exists "employee_dependents_update" on public.employee_dependents;

create policy "employee_dependents_read" on public.employee_dependents for select to authenticated
using (public.is_active_user() and (
  public.has_module_permission('funcionarios_view') or public.has_module_permission('funcionarios_manage')
));
create policy "employee_dependents_insert" on public.employee_dependents for insert to authenticated
with check (public.is_active_user() and public.has_module_permission('funcionarios_manage'));
create policy "employee_dependents_update" on public.employee_dependents for update to authenticated
using (public.is_active_user() and public.has_module_permission('funcionarios_manage'))
with check (public.is_active_user() and public.has_module_permission('funcionarios_manage'));

commit;