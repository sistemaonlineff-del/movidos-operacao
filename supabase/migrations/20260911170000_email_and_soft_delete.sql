create table if not exists public.email_templates (
  key text primary key,
  subject text not null default '',
  body text not null default '',
  updated_by uuid references public.user_profiles(id) on delete set null,
  updated_at timestamptz not null default timezone('utc', now())
);

insert into public.email_templates (key, subject, body) values (
  'financial_closing',
  'FECHAMENTO 2Q DE JUNHO - IMILE',
  E'BOA TARDE!\n\nSEGUE EM ANEXO O FECHAMENTO REFERENTE AO PERÍODO DE 15 A 30/06, 2Q DE JUNHO, DA IMILE DELIVERY.\n\nPEÇO QUE SE ALGUÉM QUISER CONTESTAR É SÓ ENVIAR AS CÂMERAS DO MOMENTO EM QUE A SACA COM AQUELE PACOTE EXTRAVIA FOI FEITA, DO INÍCIO AO FIM DA SACA. NÃO PRECISA SER FILMAGEM QUE MOSTRE O QUE ESTÁ ESCRITO NO PACOTE, MAS PRECISO QUE MOSTRE COLOCANDO NA SACA A MESMA QUANTIDADE DE PACOTES QUE CONSTAM NO SISTEMA E DEPOIS FECHANDO A SACA, SÓ ISSO JÁ É SUFICIENTE. QUEM NÃO TEM CÂMERA, RECOMENDO QUE INVISTA EM UMA BARATINHA COM CARTÃO DE MEMÓRIA E COLOQUE FILMANDO O LOCAL ONDE AS SACAS SÃO FEITAS, COM 2 CARTÕES DE MEMÓRIA É POSSÍVEL GRAVAR 30 DIAS OU MAIS, DEPENDENDO DA CÂMERA.\n\nEM CASO DE DÚVIDAS, ESTAMOS À DISPOSIÇÃO.\n\nATENCIOSAMENTE,\nTALITA PREVIATTI.\n(11) 92622-6508'
) on conflict (key) do nothing;

drop trigger if exists email_templates_updated_at on public.email_templates;
create trigger email_templates_updated_at before update on public.email_templates for each row execute function public.set_updated_at();
alter table public.email_templates enable row level security;
create policy "email_templates_read" on public.email_templates for select to authenticated using (public.is_active_user());
create policy "email_templates_write" on public.email_templates for all to authenticated
using (public.is_admin() or exists(select 1 from public.user_profiles where id=auth.uid() and role='financeiro' and is_active))
with check (public.is_admin() or exists(select 1 from public.user_profiles where id=auth.uid() and role='financeiro' and is_active));

alter table public.email_logs add column if not exists period_label text;
alter table public.email_logs add column if not exists partner text;
alter table public.email_logs add column if not exists drop_name_snapshot text;
alter table public.email_logs add column if not exists responsible text;
alter table public.email_logs add column if not exists subject text;
alter table public.email_logs add column if not exists attachment_name text;
alter table public.email_logs drop constraint if exists email_logs_status_check;
alter table public.email_logs add constraint email_logs_status_check check (status in ('enviado','preparado','erro'));
drop policy if exists "email_logs_admin" on public.email_logs;
create policy "email_logs_read" on public.email_logs for select to authenticated using (public.is_active_user());
create policy "email_logs_insert" on public.email_logs for insert to authenticated with check (public.is_admin() or exists(select 1 from public.user_profiles where id=auth.uid() and role='financeiro' and is_active));

alter table public.drops add column if not exists is_active boolean not null default true;
alter table public.drops add column if not exists deactivated_reason text;
alter table public.drops add column if not exists deactivated_at timestamptz;
alter table public.drops add column if not exists deactivated_by uuid references public.user_profiles(id) on delete set null;
create policy "drops_soft_delete" on public.drops for update to authenticated using (public.is_active_user()) with check (public.is_active_user());

alter table public.drop_documents add column if not exists is_active boolean not null default true;
alter table public.drop_documents add column if not exists deactivated_reason text;
alter table public.drop_documents add column if not exists deactivated_at timestamptz;
alter table public.drop_documents add column if not exists deactivated_by uuid references public.user_profiles(id) on delete set null;

alter table public.employee_dependents add column if not exists is_active boolean not null default true;
alter table public.employee_dependents add column if not exists deactivated_reason text;
alter table public.employee_dependents add column if not exists deactivated_at timestamptz;
alter table public.employee_dependents add column if not exists deactivated_by uuid references public.user_profiles(id) on delete set null;

create or replace function public.prevent_business_record_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'Exclusão física bloqueada. Desative o registro e informe o motivo.';
end;
$$;

drop trigger if exists prevent_drops_delete on public.drops;
create trigger prevent_drops_delete before delete on public.drops for each row execute function public.prevent_business_record_delete();
drop trigger if exists prevent_drop_documents_delete on public.drop_documents;
create trigger prevent_drop_documents_delete before delete on public.drop_documents for each row execute function public.prevent_business_record_delete();
drop trigger if exists prevent_employee_dependents_delete on public.employee_dependents;
create trigger prevent_employee_dependents_delete before delete on public.employee_dependents for each row execute function public.prevent_business_record_delete();
