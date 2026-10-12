begin;

alter table public.financial_periods drop constraint if exists financial_periods_label_key;
alter table public.financial_periods drop constraint if exists financial_periods_label_partner_key;
drop index if exists public.financial_periods_view_label_partner_key;
create unique index if not exists financial_periods_view_label_partner_reference_key on public.financial_periods(financial_view_id,label,partner,(coalesce(reference_cnpj,'MOVIDOS'))) nulls not distinct;

create table if not exists public.financial_view_changes (
  id uuid primary key default gen_random_uuid(),
  financial_view_id uuid not null references public.financial_views(id),
  action text not null check (action in ('rename', 'deactivate')),
  old_title text not null,
  new_title text,
  reason text not null,
  created_by uuid references public.user_profiles(id),
  created_at timestamptz not null default now()
);
alter table public.financial_view_changes enable row level security;
drop policy if exists financial_view_changes_read on public.financial_view_changes;
create policy financial_view_changes_read on public.financial_view_changes for select to authenticated
using (public.is_active_user() and (public.is_admin() or public.has_module_permission('financeiro_view') or public.has_module_permission('financeiro_manage')));
grant select on public.financial_view_changes to authenticated;

create or replace function public.guard_financial_period_duplicate() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare identity text; logistics text;
begin
  if not new.is_active or new.financial_view_id is null then return new; end if;
  logistics:=coalesce(new.logistics_partner,case when new.partner in ('IMILE DELIVERY BRAZIL LTDA','J&T EXPRESS LTDA') then new.partner else 'IMILE DELIVERY BRAZIL LTDA' end);
  identity := upper(trim(new.label)) || '|' || upper(trim(logistics)) || '|' || coalesce(new.reference_cnpj, 'MOVIDOS');
  perform pg_advisory_xact_lock(hashtextextended(identity, 0));
  if exists (select 1 from public.financial_periods other where other.is_active and other.id <> new.id
    and other.financial_view_id is distinct from new.financial_view_id
    and upper(trim(other.label)) = upper(trim(new.label))
    and upper(trim(coalesce(other.logistics_partner, case when other.partner in ('IMILE DELIVERY BRAZIL LTDA','J&T EXPRESS LTDA') then other.partner else 'IMILE DELIVERY BRAZIL LTDA' end))) = upper(trim(logistics))
    and coalesce(other.reference_cnpj, 'MOVIDOS') = coalesce(new.reference_cnpj, 'MOVIDOS')) then
    raise exception 'Fechamento duplicado: periodo, parceiro e CNPJ ja possuem uma View ativa.' using errcode = '23505';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_financial_period_duplicate on public.financial_periods;
create trigger guard_financial_period_duplicate before insert or update of label, partner, logistics_partner, reference_cnpj, financial_view_id, is_active on public.financial_periods for each row execute function public.guard_financial_period_duplicate();

create or replace function public.change_financial_view(view_id uuid, expected_title text, action text, reason text, new_title text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare current_view public.financial_views; period_ids uuid[];
begin
  if auth.uid() is null or public.is_active_user() is not true or (public.is_admin() or public.has_module_permission('financeiro_manage')) is not true then raise exception 'Sem permissao financeira.' using errcode='42501'; end if;
  if action is null or action not in ('rename','deactivate') or length(trim(coalesce(reason,''))) < 5 then raise exception 'Informe a acao e um motivo com ao menos cinco caracteres.'; end if;
  select * into current_view from public.financial_views where id=view_id and is_active for update;
  if not found or current_view.title is distinct from expected_title then raise exception 'A View mudou ou esta inativa. Atualize antes de continuar.'; end if;
  select coalesce(array_agg(id),array[]::uuid[]) into period_ids from public.financial_periods where financial_view_id=view_id;
  if action='rename' then
    if length(trim(coalesce(new_title,''))) not between 3 and 160 then raise exception 'Informe um periodo valido.'; end if;
    if exists(select 1 from public.email_logs where financial_period_id=any(period_ids) and status in ('aceito','enviando','incerto','enviado')) then raise exception 'Ha envios registrados para este fechamento. Reconcilie os envios antes de corrigir o periodo.'; end if;
    if exists(select 1 from public.financial_periods current_period join public.financial_periods other on upper(trim(other.label))=upper(trim(new_title)) and coalesce(other.reference_cnpj,'MOVIDOS')=coalesce(current_period.reference_cnpj,'MOVIDOS') and coalesce(other.logistics_partner,other.partner)=coalesce(current_period.logistics_partner,current_period.partner) where current_period.id=any(period_ids) and other.is_active and other.financial_view_id is distinct from view_id) then raise exception 'O periodo de destino ja possui fechamento para este parceiro e CNPJ.'; end if;
    update public.financial_views set title=trim(new_title) where id=view_id;
    update public.financial_periods set label=trim(new_title) where id=any(period_ids);
    update public.financial_payment_history set period_label=trim(new_title) where financial_period_id=any(period_ids);
    update public.loss_events set period_label=trim(new_title) where financial_period_id=any(period_ids);
  else
    update public.financial_views set is_active=false, deactivated_reason=trim(reason), deactivated_at=now(), deactivated_by=auth.uid() where id=view_id;
    update public.financial_periods set is_active=false, deactivated_reason=trim(reason), deactivated_at=now(), deactivated_by=auth.uid() where id=any(period_ids) and is_active;
    update public.financial_drop_items set is_active=false, deactivated_reason=trim(reason), deactivated_at=now(), deactivated_by=auth.uid() where financial_period_id=any(period_ids) and is_active;
    update public.financial_payment_history set is_active=false, deactivated_reason=trim(reason), deactivated_at=now(), deactivated_by=auth.uid() where financial_period_id=any(period_ids) and is_active;
    update public.loss_events set is_active=false, deactivated_reason=trim(reason), deactivated_at=now(), deactivated_by=auth.uid() where financial_period_id=any(period_ids) and is_active;
  end if;
  insert into public.financial_view_changes(financial_view_id,action,old_title,new_title,reason,created_by) values(view_id,action,current_view.title,case when action='rename' then trim(new_title) end,trim(reason),auth.uid());
end;
$$;
revoke all on function public.change_financial_view(uuid,text,text,text,text) from public, anon;
grant execute on function public.change_financial_view(uuid,text,text,text,text) to authenticated;
notify pgrst, 'reload schema';
commit;