begin;

alter table public.drop_registration_intake drop constraint if exists drop_registration_intake_photos_check;
alter table public.drop_registration_intake add constraint drop_registration_intake_photos_check
  check(jsonb_typeof(photos)='array' and jsonb_array_length(photos) between 1 and 5);

create or replace function public.drop_registration_reserve(client_id uuid,digest text,submission jsonb,manifest jsonb,ip_key text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $function$
declare record public.drop_registration_intake; today date := (now() at time zone 'UTC')::date;
  global_count integer; ip_count integer; photo jsonb; total_size integer := 0;
begin
  if ip_key !~ '^[a-f0-9]{64}$' or digest !~ '^[a-f0-9]{64}$' or client_id is null then raise exception 'Reserva invalida.'; end if;
  perform public.drop_registration_validate(submission);
  if jsonb_typeof(manifest) is distinct from 'array' or jsonb_array_length(manifest) not between 3 and 5 then raise exception 'Envie entre tres e cinco fotos.'; end if;
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

revoke all on function public.drop_registration_reserve(uuid,text,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.drop_registration_reserve(uuid,text,jsonb,jsonb,text) to service_role;

commit;