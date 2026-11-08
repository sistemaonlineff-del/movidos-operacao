begin;

do $$
declare target_email text;
begin
  lock table auth.users in share mode;
  foreach target_email in array array['fabioaf9@gmail.com','talitapreviatti@gmail.com'] loop
    if (select count(*) from auth.users where email = target_email) <> 1
       or not exists(select 1 from auth.users where email = target_email and email_confirmed_at is not null) then
      raise exception 'Financas: conta ausente, duplicada ou nao confirmada: %', target_email;
    end if;
  end loop;
end;
$$;

create table if not exists public.financas_workspaces (
  id uuid primary key check (id = 'f1082026-1108-4000-8000-000000000001'::uuid),
  name text not null check (length(name) between 1 and 150),
  created_at timestamptz not null default now()
);
create table if not exists public.financas_members (
  workspace_id uuid not null references public.financas_workspaces(id),
  user_id uuid not null references auth.users(id),
  role text not null check (role = 'editor'),
  primary key (workspace_id,user_id)
);
create table if not exists public.financas_books (
  workspace_id uuid primary key references public.financas_workspaces(id),
  revision integer not null default 0 check (revision >= 0),
  payload jsonb not null check (octet_length(payload::text) <= 15728640),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
create table if not exists public.financas_history (
  workspace_id uuid not null references public.financas_workspaces(id),
  revision integer not null check (revision >= 0),
  payload jsonb not null,
  changed_at timestamptz not null default now(),
  changed_by uuid not null references auth.users(id),
  primary key (workspace_id,revision)
);

create or replace function public.financas_is_text(value jsonb)
returns boolean language sql immutable set search_path = pg_catalog as $$
  select coalesce(jsonb_typeof(value) = 'string' and length(value #>> '{}') <= 10000,false)
$$;
create or replace function public.financas_is_integer(value jsonb, minimum numeric, maximum numeric)
returns boolean language sql immutable set search_path = pg_catalog as $$
  select case when jsonb_typeof(value) = 'number' then
    (value::text)::numeric = trunc((value::text)::numeric)
    and (value::text)::numeric between minimum and maximum else false end
$$;
create or replace function public.financas_is_date(value jsonb)
returns boolean language plpgsql immutable set search_path = pg_catalog as $$
declare date_text text := value #>> '{}'; parsed date;
begin
  if jsonb_typeof(value) is distinct from 'string' or date_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or date_text < '1900-01-01' or date_text > '2199-12-31' then return false; end if;
  parsed := date_text::date;
  return to_char(parsed,'YYYY-MM-DD') = date_text;
exception when others then return false;
end;
$$;

create or replace function public.financas_validate_payload(payload jsonb)
returns void language plpgsql immutable set search_path = pg_catalog, public as $$
declare field_name text; collection_name text; item jsonb; pair record; child jsonb;
begin
  if payload is null or jsonb_typeof(payload) is distinct from 'object'
     or octet_length(payload::text) > 15728640 or payload->'schemaVersion' is distinct from '1'::jsonb then
    raise exception 'Estrutura financeira invalida ou base excede 15 MB.';
  end if;
  foreach field_name in array array['transactions','plans','payments','issues','transferNames'] loop
    if jsonb_typeof(payload->field_name) is distinct from 'array' then raise exception 'Colecao invalida: %',field_name; end if;
  end loop;
  foreach field_name in array array['catalog','bank','source','projection'] loop
    if jsonb_typeof(payload->field_name) is distinct from 'object' then raise exception 'Cadastro invalido: %',field_name; end if;
  end loop;
  if jsonb_array_length(payload->'transactions') > 100000 or jsonb_array_length(payload->'plans') > 10000 then raise exception 'Base excede o limite.'; end if;
  foreach collection_name in array array['transactions','plans','payments'] loop
    for item in select value from jsonb_array_elements(payload->collection_name) loop
      if jsonb_typeof(item) is distinct from 'object' or not public.financas_is_text(item->'id') or item->>'id' = '' then raise exception 'Identificador invalido.'; end if;
    end loop;
    if exists(select 1 from jsonb_array_elements(payload->collection_name) entries group by entries->>'id' having count(*) > 1) then raise exception 'Identificador duplicado.'; end if;
  end loop;
  for item in select value from jsonb_array_elements(payload->'transactions') union all select value from jsonb_array_elements(payload->'plans') loop
    if not public.financas_is_text(item->'classification') or item->>'classification' not in ('','Receita','Despesa') then raise exception 'Classificacao invalida.'; end if;
    foreach field_name in array array['category','subcategory','detail'] loop
      if not public.financas_is_text(item->field_name) then raise exception 'Identidade invalida.'; end if;
    end loop;
  end loop;
  for item in select value from jsonb_array_elements(payload->'transactions') loop
    if not public.financas_is_date(item->'date') or not public.financas_is_text(item->'description') or not public.financas_is_text(item->'source')
       or not public.financas_is_integer(item->'amount',-999999999999,999999999999)
       or (item->'balance' is distinct from 'null'::jsonb and not public.financas_is_integer(item->'balance',-999999999999,999999999999))
       or not public.financas_is_integer(item->'order',-9007199254740991,9007199254740991) then raise exception 'Lancamento invalido.'; end if;
  end loop;
  for item in select value from jsonb_array_elements(payload->'plans') loop
    if item->>'classification' not in ('Receita','Despesa') or not public.financas_is_text(item->'pix') or not public.financas_is_text(item->'notes')
       or (item ? 'dueText' and not public.financas_is_text(item->'dueText'))
       or (item->'dueDay' is distinct from 'null'::jsonb and not public.financas_is_integer(item->'dueDay',1,31))
       or jsonb_typeof(item->'amounts') is distinct from 'object' or jsonb_typeof(item->'actualMonths') is distinct from 'array' then raise exception 'Planejamento invalido.'; end if;
    for pair in select * from jsonb_each(item->'amounts') loop
      if pair.key !~ '^20[0-9]{2}-(0[1-9]|1[0-2])$' or (pair.value <> 'null'::jsonb and not public.financas_is_integer(pair.value,0,999999999999)) then raise exception 'Competencia ou valor planejado invalido.'; end if;
    end loop;
    for child in select value from jsonb_array_elements(item->'actualMonths') loop
      if jsonb_typeof(child) is distinct from 'string' or not (item->'amounts' ? (child #>> '{}')) then raise exception 'Competencia automatica invalida.'; end if;
    end loop;
  end loop;
  for item in select value from jsonb_array_elements(payload->'payments') loop
    foreach field_name in array array['name','responsible','pix','holder','document','date'] loop
      if not public.financas_is_text(item->field_name) then raise exception 'Pagamento invalido.'; end if;
    end loop;
    if not public.financas_is_integer(item->'amount',0,999999999999) or (item->>'date' <> '' and not public.financas_is_date(item->'date')) then raise exception 'Pagamento invalido.'; end if;
  end loop;
  if jsonb_typeof(payload->'projection'->'adjustments') is distinct from 'object'
     or not public.financas_is_integer(payload->'projection'->'opening',-999999999999,999999999999) then raise exception 'Projecao invalida.'; end if;
  for pair in select * from jsonb_each(payload->'projection'->'adjustments') loop
    if pair.key !~ '^20[0-9]{2}-(0[1-9]|1[0-2])$' or jsonb_typeof(pair.value) is distinct from 'object'
       or not public.financas_is_integer(pair.value->'participation',-999999999999,999999999999)
       or not public.financas_is_integer(pair.value->'other',-999999999999,999999999999) then raise exception 'Ajuste de projecao invalido.'; end if;
  end loop;
  foreach field_name in array array['branch','branchDigit','account','accountDigit','name','document','street','number','complement','city','state','postalCode'] loop
    if not public.financas_is_text(payload->'bank'->field_name) then raise exception 'Cadastro bancario incompleto.'; end if;
  end loop;
  if not public.financas_is_integer(payload->'bank'->'sequence',1,999999) then raise exception 'Sequencial invalido.'; end if;
  for pair in select * from jsonb_each(payload->'bank') where key <> 'sequence' loop
    if not public.financas_is_text(pair.value) then raise exception 'Dados bancarios invalidos.'; end if;
  end loop;
  if jsonb_typeof(payload->'catalog'->'children') is distinct from 'object' then raise exception 'Catalogo invalido.'; end if;
  foreach field_name in array array['income','expense'] loop
    if jsonb_typeof(payload->'catalog'->field_name) is distinct from 'array' then raise exception 'Catalogo invalido.'; end if;
    for child in select value from jsonb_array_elements(payload->'catalog'->field_name) loop
      if not public.financas_is_text(child) then raise exception 'Categoria invalida.'; end if;
    end loop;
  end loop;
  for pair in select * from jsonb_each(payload->'catalog'->'children') loop
    if jsonb_typeof(pair.value) is distinct from 'array' then raise exception 'Subcategorias invalidas.'; end if;
    for child in select value from jsonb_array_elements(pair.value) loop
      if not public.financas_is_text(child) then raise exception 'Subcategoria invalida.'; end if;
    end loop;
  end loop;
  for child in select value from jsonb_array_elements(payload->'transferNames') loop
    if not public.financas_is_text(child) then raise exception 'Transferencia invalida.'; end if;
  end loop;
  for item in select value from jsonb_array_elements(payload->'issues') loop
    if jsonb_typeof(item) is distinct from 'object' then raise exception 'Ocorrencia invalida.'; end if;
    foreach field_name in array array['code','sheet','cell','message'] loop
      if not public.financas_is_text(item->field_name) then raise exception 'Ocorrencia invalida.'; end if;
    end loop;
  end loop;
  foreach field_name in array array['name','sha256','importedAt'] loop
    if not public.financas_is_text(payload->'source'->field_name) then raise exception 'Origem invalida.'; end if;
  end loop;
  if not public.financas_is_integer(payload->'source'->'formulas',0,9007199254740991) then raise exception 'Origem invalida.'; end if;
end;
$$;

create or replace function public.financas_is_member(target_workspace uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select target_workspace = 'f1082026-1108-4000-8000-000000000001'::uuid
    and auth.uid() is not null
    and exists (
      select 1 from public.financas_members membership
      join auth.users account on account.id = membership.user_id
      join public.user_profiles profile on profile.id = account.id
      where membership.workspace_id = target_workspace and membership.user_id = auth.uid()
        and membership.role = 'editor' and profile.is_active is true
        and account.email in ('fabioaf9@gmail.com','talitapreviatti@gmail.com')
        and account.email_confirmed_at is not null
    )
$$;

alter table public.financas_workspaces enable row level security;
alter table public.financas_members enable row level security;
alter table public.financas_books enable row level security;
alter table public.financas_history enable row level security;
drop policy if exists financas_workspace_read on public.financas_workspaces;
create policy financas_workspace_read on public.financas_workspaces for select to authenticated using (public.financas_is_member(id));
drop policy if exists financas_member_read on public.financas_members;
create policy financas_member_read on public.financas_members for select to authenticated using (user_id = auth.uid() and public.financas_is_member(workspace_id));
drop policy if exists financas_book_read on public.financas_books;
create policy financas_book_read on public.financas_books for select to authenticated using (public.financas_is_member(workspace_id));
drop policy if exists financas_history_read on public.financas_history;
create policy financas_history_read on public.financas_history for select to authenticated using (public.financas_is_member(workspace_id));
revoke all on public.financas_workspaces,public.financas_members,public.financas_books,public.financas_history from public,anon,authenticated;
grant select on public.financas_workspaces,public.financas_members,public.financas_books,public.financas_history to authenticated;

create or replace function public.financas_save_book(target_workspace uuid, expected_revision integer, new_payload jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare current_book public.financas_books; saved_at timestamptz; actor uuid := auth.uid();
begin
  if not coalesce(public.financas_is_member(target_workspace),false) then raise exception 'Sem permissao para estas financas.' using errcode = '42501'; end if;
  if expected_revision is null or expected_revision < 0 then raise exception 'Revisao obrigatoria e valida.' using errcode = '22023'; end if;
  perform public.financas_validate_payload(new_payload);
  select * into current_book from public.financas_books where workspace_id = target_workspace for update;
  if not found then raise exception 'Financas nao provisionadas.'; end if;
  if current_book.revision <> expected_revision then raise exception 'Outra sessao alterou a base. Atualize e revise antes de salvar.' using errcode = '40001'; end if;
  if current_book.revision = 2147483647 then raise exception 'Limite de revisoes atingido.'; end if;
  saved_at := clock_timestamp();
  insert into public.financas_history(workspace_id,revision,payload,changed_at,changed_by)
    values(target_workspace,current_book.revision,current_book.payload,saved_at,actor);
  update public.financas_books set payload = new_payload, revision = current_book.revision + 1, updated_at = saved_at, updated_by = actor where workspace_id = target_workspace;
  return jsonb_build_object('revision',current_book.revision + 1,'updated_at',saved_at);
end;
$$;

revoke all on function public.financas_is_text(jsonb),public.financas_is_integer(jsonb,numeric,numeric),public.financas_is_date(jsonb),public.financas_validate_payload(jsonb) from public,anon,authenticated;
revoke all on function public.financas_is_member(uuid),public.financas_save_book(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.financas_is_member(uuid),public.financas_save_book(uuid,integer,jsonb) to authenticated;

insert into public.financas_workspaces(id,name) values('f1082026-1108-4000-8000-000000000001','Financas privadas') on conflict (id) do nothing;
insert into public.financas_members(workspace_id,user_id,role)
  select 'f1082026-1108-4000-8000-000000000001',id,'editor' from auth.users
  where email in ('fabioaf9@gmail.com','talitapreviatti@gmail.com') on conflict (workspace_id,user_id) do nothing;
insert into public.financas_books(workspace_id,payload)
values('f1082026-1108-4000-8000-000000000001','{"schemaVersion":1,"transactions":[],"plans":[],"payments":[],"catalog":{"income":[],"expense":[],"children":{}},"bank":{"branch":"","branchDigit":"","account":"","accountDigit":"","name":"","document":"","street":"","number":"","complement":"","city":"","state":"","postalCode":"","sequence":1},"projection":{"opening":0,"adjustments":{}},"transferNames":[],"issues":[],"source":{"name":"","sha256":"","formulas":0,"importedAt":""}}'::jsonb)
on conflict (workspace_id) do nothing;

notify pgrst,'reload schema';
commit;