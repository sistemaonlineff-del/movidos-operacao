begin;

do $migration$
begin
  if to_regclass('public.employees') is null
     or to_regprocedure('public.is_active_user()') is null
     or to_regprocedure('public.has_module_permission(text)') is null then
    raise exception 'Requer employees, is_active_user() e has_module_permission(text).';
  end if;
end;
$migration$;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('employee-documents', 'employee-documents', false, 15728640,
  array['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.employee_documents (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  file_name text not null check (length(btrim(file_name)) between 1 and 250 and file_name !~ '[[:cntrl:]/\\]'),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes between 1 and 15728640),
  storage_path text not null unique,
  status text not null default 'pending' check (status in ('pending','ready','deleted')),
  uploaded_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  deleted_by uuid references auth.users(id),
  deleted_at timestamptz,
  constraint employee_document_path check (storage_path = 'employees/' || employee_id::text || '/' || id::text || '/file.' ||
    case mime_type when 'application/pdf' then 'pdf' when 'application/msword' then 'doc'
      when 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' then 'docx'
      when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp' else null end
    and mime_type in ('application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/jpeg','image/png','image/webp'))
);
create index if not exists employee_documents_employee_created on public.employee_documents(employee_id, created_at desc);

create or replace function public.guard_employee_document() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $function$
begin
  if not public.is_active_user() or not public.has_module_permission('funcionarios_manage') then
    raise exception 'Sem permissao para gerenciar documentos de funcionarios.';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.uploaded_by is distinct from auth.uid()
       or new.deleted_at is not null or new.deleted_by is not null then
      raise exception 'Reserva de documento invalida.';
    end if;
  else
    if (new.id, new.employee_id, new.file_name, new.storage_path, new.mime_type, new.size_bytes, new.uploaded_by, new.created_at)
       is distinct from (old.id, old.employee_id, old.file_name, old.storage_path, old.mime_type, old.size_bytes, old.uploaded_by, old.created_at)
       or old.status = 'deleted' or new.status not in ('ready','deleted') then
      raise exception 'Identidade e conteudo do documento sao imutaveis.';
    end if;
    if new.status = 'ready' and not exists (
      select 1 from storage.objects where bucket_id = 'employee-documents' and name = new.storage_path
        and (metadata->>'size')::bigint = new.size_bytes and metadata->>'mimetype' = new.mime_type
    ) then
      raise exception 'Arquivo ainda nao confirmado no storage.';
    end if;
    if new.status = 'deleted' then
      if exists (select 1 from storage.objects where bucket_id = 'employee-documents' and name = new.storage_path) then
        raise exception 'Remova o arquivo do storage antes de excluir o registro.';
      end if;
      new.deleted_at := now();
      new.deleted_by := auth.uid();
    end if;
  end if;
  return new;
end;
$function$;
revoke all on function public.guard_employee_document() from public;
drop trigger if exists employee_document_guard on public.employee_documents;
create trigger employee_document_guard before insert or update on public.employee_documents
for each row execute function public.guard_employee_document();

alter table public.employee_documents enable row level security;
revoke all on public.employee_documents from anon, authenticated;
grant select on public.employee_documents to authenticated;
grant insert(id, employee_id, file_name, mime_type, size_bytes, storage_path) on public.employee_documents to authenticated;
grant update(status) on public.employee_documents to authenticated;

drop policy if exists employee_documents_read on public.employee_documents;
create policy employee_documents_read on public.employee_documents for select to authenticated
using (public.is_active_user() and exists (select 1 from public.employees where id = employee_id)
  and ((status = 'ready' and public.has_module_permission('funcionarios_view'))
    or public.has_module_permission('funcionarios_manage')));
drop policy if exists employee_documents_insert on public.employee_documents;
create policy employee_documents_insert on public.employee_documents for insert to authenticated
with check (public.is_active_user() and public.has_module_permission('funcionarios_manage')
  and uploaded_by = auth.uid() and status = 'pending'
  and exists (select 1 from public.employees where id = employee_id));
drop policy if exists employee_documents_update on public.employee_documents;
create policy employee_documents_update on public.employee_documents for update to authenticated
using (public.is_active_user() and public.has_module_permission('funcionarios_manage')
  and status <> 'deleted' and exists (select 1 from public.employees where id = employee_id))
with check (public.is_active_user() and public.has_module_permission('funcionarios_manage')
  and exists (select 1 from public.employees where id = employee_id));

drop policy if exists employee_objects_read on storage.objects;
create policy employee_objects_read on storage.objects for select to authenticated
using (bucket_id = 'employee-documents' and exists (
  select 1 from public.employee_documents where storage_path = name and status <> 'deleted'
));
drop policy if exists employee_objects_insert on storage.objects;
create policy employee_objects_insert on storage.objects for insert to authenticated
with check (bucket_id = 'employee-documents' and public.is_active_user() and public.has_module_permission('funcionarios_manage')
  and exists (select 1 from public.employee_documents where storage_path = name and status = 'pending' and uploaded_by = auth.uid()));
drop policy if exists employee_objects_delete on storage.objects;
create policy employee_objects_delete on storage.objects for delete to authenticated
using (bucket_id = 'employee-documents' and public.is_active_user() and public.has_module_permission('funcionarios_manage')
  and exists (select 1 from public.employee_documents where storage_path = name and status <> 'deleted'));

drop policy if exists employee_objects_read_guard on storage.objects;
create policy employee_objects_read_guard on storage.objects as restrictive for select to authenticated
using (bucket_id <> 'employee-documents' or (public.is_active_user() and exists (
  select 1 from public.employee_documents where storage_path = name and status <> 'deleted'
)));
drop policy if exists employee_objects_insert_guard on storage.objects;
create policy employee_objects_insert_guard on storage.objects as restrictive for insert to authenticated
with check (bucket_id <> 'employee-documents' or (public.is_active_user() and public.has_module_permission('funcionarios_manage')
  and exists (select 1 from public.employee_documents where storage_path = name and status = 'pending' and uploaded_by = auth.uid())));
drop policy if exists employee_objects_update_guard on storage.objects;
create policy employee_objects_update_guard on storage.objects as restrictive for update to authenticated
using (bucket_id <> 'employee-documents') with check (bucket_id <> 'employee-documents');
drop policy if exists employee_objects_delete_guard on storage.objects;
create policy employee_objects_delete_guard on storage.objects as restrictive for delete to authenticated
using (bucket_id <> 'employee-documents' or (public.is_active_user() and public.has_module_permission('funcionarios_manage')
  and exists (select 1 from public.employee_documents where storage_path = name and status <> 'deleted')));

drop policy if exists employee_objects_anon_guard on storage.objects;
create policy employee_objects_anon_guard on storage.objects as restrictive for all to anon
using (bucket_id <> 'employee-documents') with check (bucket_id <> 'employee-documents');

notify pgrst, 'reload schema';
commit;