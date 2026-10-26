begin;

create table if not exists public.mais_envios_registrations (
  id uuid primary key default gen_random_uuid(),
  etapa smallint not null default 1 check (etapa between 1 and 6),
  cnpj text not null default '' check (cnpj = '' or cnpj ~ '^[0-9]{14}$'),
  smart text not null check (length(btrim(smart)) between 1 and 300),
  responsavel text not null default '',
  telefone text not null default '',
  email text not null default '' check (email = '' or email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  endereco text not null default '',
  numero text not null default '',
  complemento text not null default '',
  bairro text not null default '',
  cidade text not null default '',
  uf text not null default '' check (uf = '' or uf ~ '^[A-Z]{2}$'),
  cep text not null default '' check (cep = '' or cep ~ '^[0-9]{8}$'),
  tamanho_camiseta text not null default '',
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint mais_envios_field_lengths check (
    greatest(length(responsavel), length(telefone), length(email), length(endereco),
      length(numero), length(complemento), length(bairro), length(cidade), length(tamanho_camiseta)) <= 300
  )
);

create index if not exists mais_envios_stage_created_idx
  on public.mais_envios_registrations(etapa, created_at desc, id);
create index if not exists mais_envios_created_idx
  on public.mais_envios_registrations(created_at desc, id);

create table if not exists public.mais_envios_stage_history (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.mais_envios_registrations(id),
  previous_stage smallint check (previous_stage between 1 and 6),
  etapa smallint not null check (etapa between 1 and 6),
  changed_by uuid not null,
  changed_at timestamptz not null default clock_timestamp()
);

create index if not exists mais_envios_history_registration_idx
  on public.mais_envios_stage_history(registration_id, changed_at desc, id);

create or replace function public.mais_envios_registration_guard() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if auth.uid() is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := clock_timestamp();
  elsif new.id is distinct from old.id
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at then
    raise exception 'Identidade e autoria do cadastro sao imutaveis.';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create or replace function public.mais_envios_record_stage() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.mais_envios_stage_history(registration_id, previous_stage, etapa, changed_by)
      values(new.id, null, new.etapa, auth.uid());
  elsif new.etapa is distinct from old.etapa then
    insert into public.mais_envios_stage_history(registration_id, previous_stage, etapa, changed_by)
      values(new.id, old.etapa, new.etapa, auth.uid());
  end if;
  return new;
end;
$$;

create or replace function public.mais_envios_immutable_history() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  raise exception 'Historico de etapas e imutavel.';
end;
$$;

revoke all on function public.mais_envios_registration_guard() from public, anon, authenticated;
revoke all on function public.mais_envios_record_stage() from public, anon, authenticated;
revoke all on function public.mais_envios_immutable_history() from public, anon, authenticated;

drop trigger if exists mais_envios_registration_guard on public.mais_envios_registrations;
create trigger mais_envios_registration_guard before insert or update on public.mais_envios_registrations
  for each row execute function public.mais_envios_registration_guard();
drop trigger if exists mais_envios_record_stage on public.mais_envios_registrations;
create trigger mais_envios_record_stage after insert or update on public.mais_envios_registrations
  for each row execute function public.mais_envios_record_stage();
drop trigger if exists mais_envios_immutable_history on public.mais_envios_stage_history;
create trigger mais_envios_immutable_history before update or delete on public.mais_envios_stage_history
  for each row execute function public.mais_envios_immutable_history();

alter table public.mais_envios_registrations enable row level security;
alter table public.mais_envios_stage_history enable row level security;
revoke all on public.mais_envios_registrations from public, anon, authenticated;
revoke all on public.mais_envios_stage_history from public, anon, authenticated;
grant select, insert, update on public.mais_envios_registrations to authenticated;
grant select on public.mais_envios_stage_history to authenticated;

drop policy if exists mais_envios_read on public.mais_envios_registrations;
create policy mais_envios_read on public.mais_envios_registrations for select to authenticated
  using (public.is_active_user() and public.has_module_permission('cadastros_view'));
drop policy if exists mais_envios_create on public.mais_envios_registrations;
create policy mais_envios_create on public.mais_envios_registrations for insert to authenticated
  with check (public.is_active_user() and public.has_module_permission('cadastros_view') and public.has_module_permission('cadastros_create'));
drop policy if exists mais_envios_edit on public.mais_envios_registrations;
create policy mais_envios_edit on public.mais_envios_registrations for update to authenticated
  using (public.is_active_user() and public.has_module_permission('cadastros_view') and public.has_module_permission('cadastros_edit'))
  with check (public.is_active_user() and public.has_module_permission('cadastros_view') and public.has_module_permission('cadastros_edit'));
drop policy if exists mais_envios_history_read on public.mais_envios_stage_history;
create policy mais_envios_history_read on public.mais_envios_stage_history for select to authenticated
  using (public.is_active_user() and public.has_module_permission('cadastros_view'));

notify pgrst, 'reload schema';
commit;