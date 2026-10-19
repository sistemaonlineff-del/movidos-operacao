begin;
do $$
declare
  target_id uuid := null;
  target public.financial_views;
  period_ids uuid[];
  explanation text := 'Exclusao solicitada: 35 corresponde a 1Q e 36 a 2Q de setembro; View 35. 2Q incorreta.';
begin
  if target_id is null then
    raise exception 'Informe em target_id o UUID conferido pela consulta inspect_september_views.sql. Nenhum dado foi alterado.';
  end if;
  lock table public.financial_views, public.financial_periods,
    public.financial_drop_items, public.financial_payment_history,
    public.loss_events in share row exclusive mode;
  select * into target from public.financial_views where id = target_id for update;
  if not found or target.title is distinct from '35. 2Q DE SETEMBRO' then
    raise exception 'UUID ausente ou titulo diferente de 35. 2Q DE SETEMBRO. Operacao cancelada.';
  end if;
  if exists (select 1 from public.financial_periods where financial_view_id = target_id and label is distinct from target.title) then
    raise exception 'Esta View possui periodos com outro titulo. Confira os vinculos antes de excluir.';
  end if;
  if target.is_active is not true then
    raise notice 'A View ja esta excluida do uso do sistema. Nenhuma alteracao realizada.';
    return;
  end if;
  select coalesce(array_agg(id), array[]::uuid[]) into period_ids
    from public.financial_periods where financial_view_id = target_id;
  update public.financial_views set is_active = false, deactivated_reason = explanation,
    deactivated_at = now(), deactivated_by = null where id = target_id;
  update public.financial_periods set is_active = false, deactivated_reason = explanation,
    deactivated_at = now(), deactivated_by = null where id = any(period_ids) and is_active;
  update public.financial_drop_items set is_active = false, deactivated_reason = explanation,
    deactivated_at = now(), deactivated_by = null where financial_period_id = any(period_ids) and is_active;
  update public.financial_payment_history set is_active = false, deactivated_reason = explanation,
    deactivated_at = now(), deactivated_by = null where financial_period_id = any(period_ids) and is_active;
  update public.loss_events set is_active = false, deactivated_reason = explanation,
    deactivated_at = now(), deactivated_by = null where financial_period_id = any(period_ids) and is_active;
  insert into public.financial_view_changes(financial_view_id, action, old_title, reason)
    values(target_id, 'deactivate', target.title, explanation || ' Executada manualmente pelo administrador no SQL Editor.');
end;
$$;
commit;