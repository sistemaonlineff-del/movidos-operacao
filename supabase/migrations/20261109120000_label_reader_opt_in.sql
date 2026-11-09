begin;
alter table public.user_module_permissions alter column label_reader_access set default false;
commit;