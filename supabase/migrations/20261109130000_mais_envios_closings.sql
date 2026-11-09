begin;
create or replace function public.can_mais_envios_finance(manage boolean default false) returns boolean
language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.user_profiles profile where profile.id=auth.uid() and profile.is_active
    and (profile.role='admin' or exists(select 1 from public.user_module_permissions permission where permission.user_id=profile.id
      and (permission.financeiro_manage or (not manage and permission.financeiro_view)))))
$$;
revoke all on function public.can_mais_envios_finance(boolean) from public;
grant execute on function public.can_mais_envios_finance(boolean) to authenticated,service_role;

create table if not exists public.mais_envios_closings (
  id uuid primary key,
  period text not null check(length(btrim(period)) between 1 and 100),
  rows jsonb not null check(jsonb_typeof(rows)='array' and jsonb_array_length(rows) between 1 and 20000 and octet_length(rows::text)<=3000000),
  contacts jsonb not null check(jsonb_typeof(contacts)='array' and octet_length(contacts::text)<=300000),
  subject text not null check(length(btrim(subject)) between 1 and 200 and subject !~ E'[\r\n]'),
  body text not null check(length(btrim(body)) between 1 and 30000),
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now()
);
create unique index if not exists mais_envios_closings_period_unique on public.mais_envios_closings(lower(btrim(period)));

create or replace function public.guard_mais_envios_closing() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if tg_op<>'INSERT' then raise exception 'Fechamento confirmado e imutavel. Preserve o snapshot original.'; end if;
  if not public.can_mais_envios_finance(true) or new.created_by is distinct from auth.uid() then raise exception 'Sem permissao para confirmar fechamento Mais Envios.'; end if;
  perform pg_advisory_xact_lock(hashtext('mais-envios-closings'));
  if exists(select 1 from jsonb_array_elements(new.rows) item where
    coalesce(item->>'kind','') not in ('marketplace','posting') or coalesce(item->>'validity','') not in ('valid','invalid','duplicate')
    or coalesce(item->>'period','')<>new.period or length(btrim(coalesce(item->>'smart','')))=0
    or length(btrim(coalesce(item->>'code','')))=0 or coalesce(item->>'valueCents','') !~ '^-?[0-9]{1,13}$'
    or jsonb_typeof(item->'values') is distinct from 'array'
    or coalesce(item->>'id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception 'Confira as linhas, validacoes e Smarts antes de confirmar.';
  end if;
  if (select count(distinct item->>'id') from jsonb_array_elements(new.rows) item)<>jsonb_array_length(new.rows) then raise exception 'Identificadores repetidos.'; end if;
  if exists(select 1 from jsonb_array_elements(new.rows) item group by item->>'kind',upper(item->>'code')
    having count(*) filter(where item->>'kind'='posting' or item->>'validity'='valid')>1) then raise exception 'Etiquetas ou codigos validos repetidos.'; end if;
  if exists(select 1 from jsonb_array_elements(new.rows) item where
    (select count(*) from jsonb_array_elements(new.contacts) contact where lower(btrim(contact->>'smart'))=lower(btrim(item->>'smart')))<>1) then
    raise exception 'Confira o contato unico de cada Smart.';
  end if;
  if exists(select 1 from public.mais_envios_closings saved cross join lateral jsonb_array_elements(saved.rows) old_item
    cross join jsonb_array_elements(new.rows) item where old_item->>'kind'=item->>'kind' and upper(old_item->>'code')=upper(item->>'code')
    and (item->>'kind'='posting' or item->>'validity'='valid')) then raise exception 'Etiqueta ou codigo ja confirmado em outro fechamento. Atualize e revise as duplicidades.'; end if;
  return new;
end;
$$;
revoke all on function public.guard_mais_envios_closing() from public;
drop trigger if exists mais_envios_closings_guard on public.mais_envios_closings;
create trigger mais_envios_closings_guard before insert or update or delete on public.mais_envios_closings for each row execute function public.guard_mais_envios_closing();
alter table public.mais_envios_closings enable row level security;
revoke all on public.mais_envios_closings from anon,authenticated;
grant select,insert on public.mais_envios_closings to authenticated;
grant select on public.mais_envios_closings to service_role;
drop policy if exists mais_envios_closings_read on public.mais_envios_closings;
create policy mais_envios_closings_read on public.mais_envios_closings for select to authenticated using(public.can_mais_envios_finance(false));
drop policy if exists mais_envios_closings_insert on public.mais_envios_closings;
create policy mais_envios_closings_insert on public.mais_envios_closings for insert to authenticated with check(public.can_mais_envios_finance(true) and created_by=auth.uid());

create table if not exists public.mais_envios_closing_mail (
  id uuid primary key default gen_random_uuid(),
  closing_id uuid not null references public.mais_envios_closings(id),
  smart_key text not null,
  recipient text not null,
  status text not null check(status in ('enviando','aceito','incerto')),
  error_message text,
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique(closing_id,smart_key)
);
alter table public.mais_envios_closing_mail enable row level security;
revoke all on public.mais_envios_closing_mail from anon,authenticated;
grant select on public.mais_envios_closing_mail to authenticated;
grant select,insert,update on public.mais_envios_closing_mail to service_role;
drop policy if exists mais_envios_closing_mail_read on public.mais_envios_closing_mail;
create policy mais_envios_closing_mail_read on public.mais_envios_closing_mail for select to authenticated using(public.can_mais_envios_finance(false));
commit;