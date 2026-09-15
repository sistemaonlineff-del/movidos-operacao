alter table public.app_notes drop constraint if exists app_notes_key_check;
alter table public.app_notes add constraint app_notes_key_check
  check (key in ('general', 'financial', 'ready_messages_draft'));
