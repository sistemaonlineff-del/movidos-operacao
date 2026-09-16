begin;

drop policy if exists "contract_templates_insert_admin" on storage.objects;
create policy "contract_templates_insert_admin" on storage.objects as restrictive
for insert to authenticated
with check (bucket_id <> 'movidos-documents' or name not like 'contract-templates/%' or public.is_admin());

drop policy if exists "contract_templates_update_admin" on storage.objects;
create policy "contract_templates_update_admin" on storage.objects as restrictive
for update to authenticated
using (bucket_id <> 'movidos-documents' or name not like 'contract-templates/%' or public.is_admin())
with check (bucket_id <> 'movidos-documents' or name not like 'contract-templates/%' or public.is_admin());

drop policy if exists "contract_templates_delete_admin" on storage.objects;
create policy "contract_templates_delete_admin" on storage.objects as restrictive
for delete to authenticated
using (bucket_id <> 'movidos-documents' or name not like 'contract-templates/%' or public.is_admin());

commit;