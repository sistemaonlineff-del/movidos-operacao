begin;

do $$
begin
  if to_regprocedure('public.guard_drop_duplicate()') is null
    or to_regprocedure('public.registration_identity(text)') is null
    or (select count(*) from pg_attribute
      where attrelid=to_regclass('public.drops')
        and attname in ('operation_started_at','operation_ended_at')
        and atttypid='date'::regtype and not attisdropped)<>2 then
    raise exception 'Prerequisito ausente: guard_drop_duplicate, registration_identity e datas de operacao existentes sao obrigatorios.';
  end if;
  if not exists(select 1 from pg_trigger
    where tgrelid=to_regclass('public.drops') and tgname='guard_drop_duplicate'
      and tgfoid=to_regprocedure('public.guard_drop_duplicate()')
      and not tgisinternal and tgenabled in ('O','A')
      and (tgtype::integer & 23)=23) then
    raise exception 'Prerequisito ausente: trigger guard_drop_duplicate ativo para INSERT e UPDATE.';
  end if;
end;
$$;

create or replace function public.guard_drop_duplicate()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare identity text;
begin
  if new.operation_started_at > new.operation_ended_at then raise exception 'Fim da operacao anterior ao inicio.' using errcode='23514'; end if;
  if not new.is_active and new.operation_started_at is null and new.operation_ended_at is null
    and (tg_op<>'UPDATE' or old.is_active is not true) then return new; end if;
  identity:=public.registration_identity(new.name)||'|'||public.registration_identity(new.partner)||'|'||public.registration_identity(new.municipality)||'|'||coalesce(new.registration_type,'drop_off');
  if tg_op='UPDATE'
    and identity=public.registration_identity(old.name)||'|'||public.registration_identity(old.partner)||'|'||public.registration_identity(old.municipality)||'|'||coalesce(old.registration_type,'drop_off')
    and new.operation_started_at is not distinct from old.operation_started_at
    and new.operation_ended_at is not distinct from old.operation_ended_at
    and new.is_active is not distinct from old.is_active then return new; end if;
  if public.registration_identity(new.name)='' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(identity,1));
  if tg_op='UPDATE'
    and old.is_active is true and new.is_active is false
    and public.registration_identity(new.name)=public.registration_identity(old.name)
    and public.registration_identity(new.partner)=public.registration_identity(old.partner)
    and public.registration_identity(new.municipality)=public.registration_identity(old.municipality)
    and coalesce(new.registration_type,'drop_off')=coalesce(old.registration_type,'drop_off')
    and coalesce(new.operation_started_at,'-infinity'::date)>=coalesce(old.operation_started_at,'-infinity'::date)
    and coalesce(new.operation_ended_at,'infinity'::date)<=coalesce(old.operation_ended_at,'infinity'::date) then return new; end if;
  if tg_op='UPDATE'
    and public.registration_identity(new.name)=public.registration_identity(old.name)
    and public.registration_identity(new.partner)=public.registration_identity(old.partner)
    and public.registration_identity(new.municipality)=public.registration_identity(old.municipality)
    and coalesce(new.registration_type,'drop_off')=coalesce(old.registration_type,'drop_off')
    and new.is_active is not distinct from old.is_active
    and coalesce(new.operation_started_at,'-infinity'::date)>=coalesce(old.operation_started_at,'-infinity'::date)
    and coalesce(new.operation_ended_at,'infinity'::date)<=coalesce(old.operation_ended_at,'infinity'::date)
    and (coalesce(new.operation_started_at,'-infinity'::date)>coalesce(old.operation_started_at,'-infinity'::date)
      or coalesce(new.operation_ended_at,'infinity'::date)<coalesce(old.operation_ended_at,'infinity'::date)) then return new; end if;
  if exists(select 1 from public.drops other where other.id<>new.id
    and (other.is_active or other.operation_started_at is not null or other.operation_ended_at is not null)
    and public.registration_identity(other.name)=public.registration_identity(new.name)
    and public.registration_identity(other.partner)=public.registration_identity(new.partner)
    and public.registration_identity(other.municipality)=public.registration_identity(new.municipality)
    and coalesce(other.registration_type,'drop_off')=coalesce(new.registration_type,'drop_off')
    and coalesce(other.operation_started_at,'-infinity'::date)<=coalesce(new.operation_ended_at,'infinity'::date)
    and coalesce(new.operation_started_at,'-infinity'::date)<=coalesce(other.operation_ended_at,'infinity'::date)) then
    raise exception 'Cadastro duplicado ou operacoes sobrepostas: confira inicio e fim dos responsaveis deste ponto.' using errcode='23505';
  end if;
  return new;
end;
$$;

notify pgrst, 'reload schema';
commit;