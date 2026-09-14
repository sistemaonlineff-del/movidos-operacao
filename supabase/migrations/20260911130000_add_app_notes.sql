create table if not exists public.app_notes (
  key text primary key check (key in ('general', 'financial')),
  content text not null default '',
  updated_by uuid references public.user_profiles(id) on delete set null,
  updated_at timestamptz not null default timezone('utc', now())
);

insert into public.app_notes (key, content) values
  ('general', 'RDJ 17 VAI ATENDER ATÉ 24/05. PROCURAR OUTRO PARA O LUGAR DO RDJ 17'),
  ('financial', E'CDM ATÉ 19/03\n\nTESTE\n\nTESTE2')
on conflict (key) do nothing;

drop trigger if exists app_notes_updated_at on public.app_notes;
create trigger app_notes_updated_at before update on public.app_notes for each row execute function public.set_updated_at();

alter table public.app_notes enable row level security;
create policy "app_notes_read" on public.app_notes for select to authenticated using (public.is_active_user());
create policy "app_notes_write" on public.app_notes for all to authenticated using (public.is_active_user()) with check (public.is_active_user());
