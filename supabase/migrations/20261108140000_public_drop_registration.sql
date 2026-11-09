begin;

do $migration$
declare missing text[];
begin
  if to_regclass('public.user_module_permissions') is null
    or to_regprocedure('public.guard_drop_duplicate()') is null
    or not exists(select 1 from pg_attribute where attrelid='public.drops'::regclass and attname='operation_ended_at' and not attisdropped)
    or not exists(select 1 from pg_trigger where tgrelid='public.drops'::regclass and tgname='guard_drop_duplicate' and tgenabled <> 'D') then
    raise exception 'Requer schema de cadastros, permissoes, datas operacionais e guard_drop_duplicate existentes.';
  end if;
  select array_agg(required) into missing from unnest(array['id','name','responsible','phone','alternate_phone','email','cpf','cnpj','legal_name','trade_name','state_registration','address','address_number','complement','neighborhood','municipality','state','postal_code','pix_key','pix_holder_name','company_address','company_address_number','company_complement','company_neighborhood','company_municipality','company_state','company_postal_code','latitude','longitude','notes','status','partner','registration_type','is_active','operation_started_at','operation_ended_at','signed_at','terminated_at','monthly_value','created_by','deactivated_reason','deactivated_at','deactivated_by','updated_at']) required
    where not exists(select 1 from pg_attribute where attrelid='public.drops'::regclass and attname=required and not attisdropped);
  if missing is not null then raise exception 'Colunas de cadastro ausentes: %',array_to_string(missing,', '); end if;
end;
$migration$;

create table if not exists public.drop_registration_intake (
  id uuid primary key,
  content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),
  snapshot jsonb not null,
  photos jsonb not null check(jsonb_typeof(photos)='array' and jsonb_array_length(photos) between 1 and 3),
  status text not null default 'uploading' check(status in ('uploading','pending','approved','rejected')),
  revision integer not null default 0,
  review_snapshot jsonb,
  review_note text,
  reviewed_by uuid references public.user_profiles(id),
  reviewed_at timestamptz,
  approved_drop_id uuid unique references public.drops(id),
  consent_version text not null default 'drop-registration-v1' check(consent_version='drop-registration-v1'),
  consented_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(id,content_hash),
  check((status='approved')=(approved_drop_id is not null))
);
create index if not exists drop_registration_intake_created on public.drop_registration_intake(created_at desc,id);
create or replace function public.drop_registration_can_read() returns boolean
language sql stable security definer set search_path=pg_catalog,public as $function$
  select exists(select 1 from public.user_profiles profile where profile.id=auth.uid() and profile.is_active=true
    and (profile.role='admin' or exists(select 1 from public.user_module_permissions permissions where permissions.user_id=profile.id
      and permissions.cadastros_create=true and permissions.cadastros_edit=true)));
$function$;
create table if not exists public.drop_registration_limits (
  day date not null, bucket text not null, attempts integer not null default 0 check(attempts>=0), primary key(day,bucket)
);
alter table public.drop_registration_intake enable row level security;
alter table public.drop_registration_limits enable row level security;
revoke all on public.drop_registration_intake,public.drop_registration_limits from public,anon,authenticated;
grant all on public.drop_registration_intake,public.drop_registration_limits to service_role;
grant select on public.drop_registration_intake to authenticated;
drop policy if exists drop_registration_intake_deny on public.drop_registration_intake;
create policy drop_registration_intake_deny on public.drop_registration_intake as restrictive for all to anon,authenticated using(public.drop_registration_can_read()) with check(false);
drop policy if exists drop_registration_intake_read on public.drop_registration_intake;
create policy drop_registration_intake_read on public.drop_registration_intake for select to authenticated using(public.drop_registration_can_read());
drop policy if exists drop_registration_limits_deny on public.drop_registration_limits;
create policy drop_registration_limits_deny on public.drop_registration_limits as restrictive for all to anon,authenticated using(false) with check(false);

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('drop-registration-private','drop-registration-private',false,2097152,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists drop_registration_objects_isolation on storage.objects;
create policy drop_registration_objects_isolation on storage.objects as restrictive for all to anon,authenticated
using(bucket_id <> 'drop-registration-private') with check(bucket_id <> 'drop-registration-private');

create or replace function public.drop_registration_tax_document(value text,expected_length integer) returns boolean
language plpgsql immutable set search_path=pg_catalog,public as $function$
declare sequence integer[]; check_index integer; position integer; total integer; remainder integer;
begin
  if value is null then return true; end if;
  if length(value)<>expected_length or value !~ '^\d+$' or value ~ '^(\d)\1+$' or expected_length not in (11,14) then return false; end if;
  for check_index in 1..2 loop
    if expected_length=11 then
      sequence := case when check_index=1 then array[10,9,8,7,6,5,4,3,2] else array[11,10,9,8,7,6,5,4,3,2] end;
    else
      sequence := case when check_index=1 then array[5,4,3,2,9,8,7,6,5,4,3,2] else array[6,5,4,3,2,9,8,7,6,5,4,3,2] end;
    end if;
    total:=0;
    for position in 1..array_length(sequence,1) loop total:=total+substring(value from position for 1)::integer*sequence[position]; end loop;
    remainder:=total%11;
    if substring(value from expected_length-2+check_index for 1)::integer<>(case when remainder<2 then 0 else 11-remainder end) then return false; end if;
  end loop;
  return true;
end;
$function$;

create or replace function public.drop_registration_validate(value jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog,public as $function$
declare field text; result jsonb := '{}'::jsonb; item text;
  fields text[] := array['name','responsible','phone','alternate_phone','email','cpf','cnpj','legal_name','trade_name','state_registration','address','address_number','complement','neighborhood','municipality','state','postal_code','pix_key','pix_holder_name','company_address','company_address_number','company_complement','company_neighborhood','company_municipality','company_state','company_postal_code','notes'];
begin
  if value is null or jsonb_typeof(value)<>'object' then raise exception 'Snapshot invalido.'; end if;
  if exists(select 1 from jsonb_object_keys(value) key where not(key=any(fields) or key in ('latitude','longitude'))) then raise exception 'Campo nao permitido no snapshot.'; end if;
  foreach field in array fields loop
    if value ? field and jsonb_typeof(value->field) not in ('string','null') then raise exception 'Tipo invalido: %',field; end if;
    item := nullif(btrim(value->>field),'');
    if length(item)>(case when field='notes' then 2000 else 200 end) or item ~ '[[:cntrl:]]' and field<>'notes' then raise exception 'Campo invalido: %',field; end if;
    result := result || jsonb_build_object(field,item);
  end loop;
  foreach field in array array['name','responsible','phone','address','address_number','municipality','state','postal_code'] loop
    if result->>field is null then raise exception 'Campo obrigatorio: %',field; end if;
  end loop;
  if result->>'phone' !~ '^\d{10,13}$' or coalesce(result->>'alternate_phone','0000000000') !~ '^\d{10,13}$'
    or result->>'postal_code' !~ '^\d{8}$' or coalesce(result->>'company_postal_code','00000000') !~ '^\d{8}$'
    or result->>'state' !~ '^(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$'
    or coalesce(result->>'company_state','SP') !~ '^(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$'
    or (result->>'email' is not null and result->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
    or not public.drop_registration_tax_document(result->>'cpf',11) or not public.drop_registration_tax_document(result->>'cnpj',14) then raise exception 'Contato, documento ou endereco invalido.'; end if;
  item := result->>'pix_key';
  if item is not null and not (
    (length(item)<=77 and item ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
    or item ~* '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    or (item ~ '^[0-9[:space:]().+/-]+$' and (
      public.drop_registration_tax_document(regexp_replace(item,'\D','','g'),11)
      or public.drop_registration_tax_document(regexp_replace(item,'\D','','g'),14)
      or regexp_replace(item,'\D','','g') ~ '^(55)?[1-9]{2}[0-9]{8,9}$'))
  ) then raise exception 'Chave PIX invalida.'; end if;
  if jsonb_typeof(value->'latitude') is distinct from 'number' or jsonb_typeof(value->'longitude') is distinct from 'number'
    or not((value->>'latitude')::numeric between -35 and 6) or not((value->>'longitude')::numeric between -75 and -32) then raise exception 'Coordenadas brasileiras obrigatorias.'; end if;
  return result || jsonb_build_object('latitude',(value->>'latitude')::numeric,'longitude',(value->>'longitude')::numeric);
end;
$function$;

drop function if exists public.drop_registration_review(uuid,integer,text,jsonb,text,text,text);
drop function if exists public.drop_registration_duplicates(jsonb);
drop function if exists public.drop_registration_authorize();
create or replace function public.drop_registration_authorize(actor_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public as $function$
declare profile public.user_profiles; permissions public.user_module_permissions;
begin
  select * into profile from public.user_profiles where id=actor_id for share;
  if profile.id is null or profile.is_active is distinct from true then raise exception 'Sem permissao para revisar cadastros.' using errcode='42501'; end if;
  if profile.role='admin' then return; end if;
  select * into permissions from public.user_module_permissions where user_id=actor_id for share;
  if permissions.cadastros_create is distinct from true or permissions.cadastros_edit is distinct from true then raise exception 'Sem permissao para revisar cadastros.' using errcode='42501'; end if;
end;
$function$;

create or replace function public.drop_registration_reserve(client_id uuid,digest text,submission jsonb,manifest jsonb,ip_key text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $function$
declare record public.drop_registration_intake; today date := (now() at time zone 'UTC')::date;
  global_count integer; ip_count integer; photo jsonb; total_size integer := 0;
begin
  if ip_key !~ '^[a-f0-9]{64}$' or digest !~ '^[a-f0-9]{64}$' or client_id is null then raise exception 'Reserva invalida.'; end if;
  perform public.drop_registration_validate(submission);
  if jsonb_typeof(manifest) is distinct from 'array' or jsonb_array_length(manifest) not between 1 and 3 then raise exception 'Envie entre uma e tres fotos.'; end if;
  for photo in select * from jsonb_array_elements(manifest) loop
    if coalesce(photo->>'path','') !~ ('^submissions/'||client_id::text||'/[a-f0-9-]{36}\.(jpg|png|webp)$')
      or coalesce(photo->>'hash','') !~ '^[a-f0-9]{64}$' or coalesce(photo->>'type','') not in ('image/jpeg','image/png','image/webp')
      or coalesce((photo->>'size')::integer,0) not between 1 and 2097152
      or length(coalesce(photo->>'caption',''))>200 or length(coalesce(photo->>'name',''))>150 then raise exception 'Manifesto invalido.'; end if;
    total_size := total_size+(photo->>'size')::integer;
  end loop;
  if total_size>2097152 then raise exception 'Fotos excedem 2 MB no total.'; end if;
  insert into public.drop_registration_limits(day,bucket) values(today,'global') on conflict do nothing;
  select attempts into global_count from public.drop_registration_limits where day=today and bucket='global' for update;
  insert into public.drop_registration_limits(day,bucket) values(today,ip_key) on conflict do nothing;
  select attempts into ip_count from public.drop_registration_limits where day=today and bucket=ip_key for update;
  if global_count>=500 or ip_count>=20 then return null; end if;
  update public.drop_registration_limits set attempts=attempts+1 where day=today and bucket in ('global',ip_key);
  select * into record from public.drop_registration_intake where id=client_id for update;
  if record.id is not null then
    if record.content_hash<>digest then raise exception 'Protocolo ja utilizado com outro conteudo.' using errcode='23505'; end if;
    return to_jsonb(record);
  end if;
  insert into public.drop_registration_intake(id,content_hash,snapshot,photos) values(client_id,digest,submission,manifest) returning * into record;
  return to_jsonb(record);
end;
$function$;

create or replace function public.drop_registration_finalize(client_id uuid,digest text) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $function$
declare record public.drop_registration_intake; photo jsonb;
begin
  select * into record from public.drop_registration_intake where id=client_id and content_hash=digest for update;
  if record.id is null then raise exception 'Reserva nao encontrada.'; end if;
  if record.status<>'uploading' then return true; end if;
  for photo in select * from jsonb_array_elements(record.photos) loop
    if not exists(select 1 from storage.objects where bucket_id='drop-registration-private' and name=photo->>'path'
      and (metadata->>'size')::bigint=(photo->>'size')::bigint and metadata->>'mimetype'=photo->>'type') then raise exception 'Foto sem confirmacao no storage.'; end if;
  end loop;
  update public.drop_registration_intake set status='pending',revision=revision+1 where id=client_id;
  return true;
end;
$function$;

create or replace function public.drop_registration_duplicates(submission jsonb,actor_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $function$
declare result jsonb; checked jsonb;
begin
  perform public.drop_registration_authorize(actor_id);
  checked := public.drop_registration_validate(submission);
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'responsible',responsible,'address',address,'municipality',municipality,'status',status,'is_active',is_active,'updated_at',updated_at) order by id),'[]'::jsonb)
    into result from public.drops where
    (checked->>'cnpj' is not null and regexp_replace(coalesce(cnpj,''),'\D','','g')=checked->>'cnpj')
    or (checked->>'cpf' is not null and regexp_replace(coalesce(cpf,''),'\D','','g')=checked->>'cpf')
    or (public.registration_identity(name)=public.registration_identity(checked->>'name')
      and public.registration_identity(municipality)=public.registration_identity(checked->>'municipality')
      and public.registration_identity(address)=public.registration_identity(checked->>'address')
      and public.registration_identity(address_number)=public.registration_identity(checked->>'address_number'));
  return jsonb_build_object('matches',result,'acknowledgment',md5(result::text));
end;
$function$;

create or replace function public.drop_registration_review(submission_id uuid,expected_revision integer,action text,submission jsonb,note text,partner_value text,duplicate_ack text,actor_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $function$
declare record public.drop_registration_intake; checked jsonb; candidates jsonb; new_drop public.drops; result_id uuid;
begin
  perform public.drop_registration_authorize(actor_id);
  select * into record from public.drop_registration_intake where id=submission_id for update;
  if record.id is null then raise exception 'Pre-cadastro nao encontrado.'; end if;
  if record.status='approved' and action='approve' then return jsonb_build_object('status','approved','dropId',record.approved_drop_id); end if;
  if record.status<>'pending' or record.revision is distinct from expected_revision then raise exception 'Pre-cadastro mudou ou fotos incompletas. Atualize a lista.' using errcode='40001'; end if;
  if action not in ('save','reject','approve') or action is null then raise exception 'Acao invalida.'; end if;
  if length(coalesce(note,''))>2000 then raise exception 'Observacao muito longa.'; end if;
  if action='reject' then
    if length(btrim(coalesce(note,'')))<8 then raise exception 'Informe o motivo da recusa (8 caracteres).'; end if;
    update public.drop_registration_intake set status='rejected',review_note=btrim(note),reviewed_by=actor_id,reviewed_at=now(),revision=revision+1 where id=submission_id;
    return jsonb_build_object('status','rejected');
  end if;
  checked := public.drop_registration_validate(submission);
  if action='save' then
    update public.drop_registration_intake set review_snapshot=checked,review_note=note,reviewed_by=actor_id,reviewed_at=now(),revision=revision+1 where id=submission_id;
    return jsonb_build_object('status','pending');
  end if;
  if partner_value is not null and partner_value not in ('IMILE DELIVERY BRAZIL LTDA','J&T EXPRESS LTDA') then raise exception 'Parceiro invalido.'; end if;
  lock table public.drops in share row exclusive mode;
  candidates := public.drop_registration_duplicates(checked,actor_id);
  if jsonb_array_length(candidates->'matches')>0 and duplicate_ack is distinct from candidates->>'acknowledgment' then raise exception 'Reconheca os possiveis duplicados atualizados.' using errcode='23505'; end if;
  new_drop := jsonb_populate_record(null::public.drops,checked);
  insert into public.drops(name,responsible,phone,alternate_phone,email,cpf,cnpj,legal_name,trade_name,state_registration,
    address,address_number,complement,neighborhood,municipality,state,postal_code,pix_key,pix_holder_name,
    company_address,company_address_number,company_complement,company_neighborhood,company_municipality,company_state,company_postal_code,
    latitude,longitude,notes,status,partner,registration_type,is_active,operation_started_at,operation_ended_at,
    signed_at,terminated_at,monthly_value,created_by,deactivated_reason,deactivated_at,deactivated_by)
  values(new_drop.name,new_drop.responsible,new_drop.phone,new_drop.alternate_phone,new_drop.email,new_drop.cpf,new_drop.cnpj,new_drop.legal_name,new_drop.trade_name,new_drop.state_registration,
    new_drop.address,new_drop.address_number,new_drop.complement,new_drop.neighborhood,new_drop.municipality,new_drop.state,new_drop.postal_code,new_drop.pix_key,new_drop.pix_holder_name,
    new_drop.company_address,new_drop.company_address_number,new_drop.company_complement,new_drop.company_neighborhood,new_drop.company_municipality,new_drop.company_state,new_drop.company_postal_code,
    new_drop.latitude,new_drop.longitude,new_drop.notes,'INTERESSADO',partner_value,'drop_off',true,null,null,
    null,null,null,actor_id,null,null,null) returning id into result_id;
  update public.drop_registration_intake set status='approved',review_snapshot=checked,review_note=note,reviewed_by=actor_id,reviewed_at=now(),approved_drop_id=result_id,revision=revision+1 where id=submission_id;
  insert into public.audit_logs(user_id,action,entity_type,entity_id,details)
    values(actor_id,'approve_public_registration','drop',result_id,jsonb_build_object('submissionId',submission_id,'status','INTERESSADO','operationallyActivated',false,'duplicateAcknowledgment',duplicate_ack));
  return jsonb_build_object('status','approved','dropId',result_id);
end;
$function$;

revoke all on function public.drop_registration_tax_document(text,integer),public.drop_registration_validate(jsonb),public.drop_registration_can_read(),public.drop_registration_authorize(uuid),public.drop_registration_reserve(uuid,text,jsonb,jsonb,text),public.drop_registration_finalize(uuid,text),public.drop_registration_duplicates(jsonb,uuid),public.drop_registration_review(uuid,integer,text,jsonb,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.drop_registration_can_read() to authenticated;
grant execute on function public.drop_registration_authorize(uuid),public.drop_registration_reserve(uuid,text,jsonb,jsonb,text),public.drop_registration_finalize(uuid,text),public.drop_registration_duplicates(jsonb,uuid),public.drop_registration_review(uuid,integer,text,jsonb,text,text,text,uuid) to service_role;
notify pgrst,'reload schema';
commit;