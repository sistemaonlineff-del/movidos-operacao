do $$
declare table_name text;
begin
  foreach table_name in array array['financial_views','financial_periods','financial_drop_items','financial_payment_history','loss_events'] loop
    execute format('alter table public.%I add column if not exists is_active boolean not null default true', table_name);
    execute format('alter table public.%I add column if not exists deactivated_reason text', table_name);
    execute format('alter table public.%I add column if not exists deactivated_at timestamptz', table_name);
    execute format('alter table public.%I add column if not exists deactivated_by uuid references public.user_profiles(id) on delete set null', table_name);
  end loop;
end $$;

drop trigger if exists prevent_financial_views_delete on public.financial_views;
create trigger prevent_financial_views_delete before delete on public.financial_views for each row execute function public.prevent_business_record_delete();
drop trigger if exists prevent_financial_periods_delete on public.financial_periods;
create trigger prevent_financial_periods_delete before delete on public.financial_periods for each row execute function public.prevent_business_record_delete();
drop trigger if exists prevent_financial_drop_items_delete on public.financial_drop_items;
create trigger prevent_financial_drop_items_delete before delete on public.financial_drop_items for each row execute function public.prevent_business_record_delete();
drop trigger if exists prevent_financial_payment_history_delete on public.financial_payment_history;
create trigger prevent_financial_payment_history_delete before delete on public.financial_payment_history for each row execute function public.prevent_business_record_delete();
drop trigger if exists prevent_loss_events_delete on public.loss_events;
create trigger prevent_loss_events_delete before delete on public.loss_events for each row execute function public.prevent_business_record_delete();
drop trigger if exists prevent_email_logs_delete on public.email_logs;
create trigger prevent_email_logs_delete before delete on public.email_logs for each row execute function public.prevent_business_record_delete();
drop trigger if exists prevent_employees_delete on public.employees;
create trigger prevent_employees_delete before delete on public.employees for each row execute function public.prevent_business_record_delete();
