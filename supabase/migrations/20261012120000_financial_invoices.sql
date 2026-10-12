begin;
create table if not exists public.financial_invoice_requests (
  id uuid primary key default gen_random_uuid(),
  financial_period_id uuid not null references public.financial_periods(id),
  drop_id uuid not null references public.drops(id),
  drop_name text not null,
  period_label text not null,
  partner text not null,
  reference_cnpj text not null,
  token_hash text not null unique check (length(token_hash)=64),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by uuid references public.user_profiles(id),
  created_at timestamptz not null default now(),
  unique(financial_period_id,drop_id)
);
create table if not exists public.financial_invoice_files (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.financial_invoice_requests(id),
  client_upload_id uuid not null,
  file_name text not null,
  storage_path text not null unique,
  content_hash text not null check(length(content_hash)=64),
  size_bytes integer not null check(size_bytes between 1 and 3145728),
  content_type text not null check(content_type in ('application/pdf','application/xml')),
  status text not null default 'uploading' check(status in ('uploading','received','failed')),
  created_at timestamptz not null default now(),
  received_at timestamptz,
  unique(request_id,client_upload_id),
  unique(request_id,content_hash)
);
alter table public.financial_invoice_requests enable row level security;
alter table public.financial_invoice_files enable row level security;
revoke all on public.financial_invoice_requests,public.financial_invoice_files from public,anon,authenticated;
grant all on public.financial_invoice_requests,public.financial_invoice_files to service_role;

create or replace function public.guard_invoice_reservation() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare request public.financial_invoice_requests;
begin
  select * into request from public.financial_invoice_requests where id=new.request_id for update;
  if not found or request.revoked_at is not null or request.expires_at<=now() then raise exception 'Link expirado ou revogado.'; end if;
  if not exists(select 1 from public.financial_periods period left join public.financial_views view on view.id=period.financial_view_id where period.id=request.financial_period_id and period.is_active and (view.id is null or view.is_active)) then raise exception 'Fechamento inativo.'; end if;
  if (select count(*) from public.financial_invoice_files where request_id=new.request_id)>=20 then raise exception 'Limite de vinte arquivos atingido.'; end if;
  return new;
end;
$$;
drop trigger if exists guard_invoice_reservation on public.financial_invoice_files;
create trigger guard_invoice_reservation before insert on public.financial_invoice_files for each row execute function public.guard_invoice_reservation();

create or replace function public.invalidate_invoice_links() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.label is distinct from old.label or new.is_active is distinct from old.is_active or new.reference_cnpj is distinct from old.reference_cnpj then
    update public.financial_invoice_requests set revoked_at=now() where financial_period_id=new.id and revoked_at is null;
  end if;
  return new;
end;
$$;
drop trigger if exists invalidate_invoice_links on public.financial_periods;
create trigger invalidate_invoice_links after update of label,is_active,reference_cnpj on public.financial_periods for each row execute function public.invalidate_invoice_links();

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('financial-invoices','financial-invoices',false,3145728,array['application/pdf','application/xml']) on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists financial_invoices_private on storage.objects;
create policy financial_invoices_private on storage.objects as restrictive for all to authenticated,anon using(bucket_id<>'financial-invoices') with check(bucket_id<>'financial-invoices');
notify pgrst,'reload schema';
commit;