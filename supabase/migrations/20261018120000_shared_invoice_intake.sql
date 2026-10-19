begin;
create table if not exists public.financial_invoice_intake (
  id uuid primary key,
  submission_key text not null unique check(length(submission_key)=64),
  drop_name text not null check(length(drop_name) between 1 and 160),
  responsible text not null check(length(responsible) between 1 and 160),
  period_label text not null check(length(period_label) between 1 and 120),
  partner text not null,
  reference_cnpj text not null,
  file_name text not null,
  storage_path text not null unique,
  content_hash text not null check(length(content_hash)=64),
  size_bytes integer not null check(size_bytes between 1 and 3145728),
  content_type text not null check(content_type in ('application/pdf','application/xml')),
  status text not null default 'uploading' check(status in ('uploading','pending','approved')),
  financial_period_id uuid references public.financial_periods(id),
  drop_id uuid references public.drops(id),
  reviewed_by uuid references public.user_profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check(status<>'approved' or (financial_period_id is not null and drop_id is not null and reviewed_by is not null and reviewed_at is not null))
);
create table if not exists public.financial_invoice_intake_limits (
  day date not null,
  bucket text not null,
  attempts integer not null default 0,
  primary key(day,bucket)
);
alter table public.financial_invoice_intake enable row level security;
alter table public.financial_invoice_intake_limits enable row level security;
revoke all on public.financial_invoice_intake,public.financial_invoice_intake_limits from public,anon,authenticated;
grant all on public.financial_invoice_intake,public.financial_invoice_intake_limits to service_role;
create or replace function public.reserve_invoice_intake(bucket_key text) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare current_day date := (now() at time zone 'UTC')::date; total integer; individual integer;
begin
  if bucket_key !~ '^[a-f0-9]{64}$' or bucket_key is null then return false; end if;
  perform pg_advisory_xact_lock(7182026);
  insert into financial_invoice_intake_limits(day,bucket) values(current_day,'global'),(current_day,bucket_key) on conflict do nothing;
  select attempts into total from financial_invoice_intake_limits where day=current_day and bucket='global';
  select attempts into individual from financial_invoice_intake_limits where day=current_day and bucket=bucket_key;
  if total>=1000 or individual>=50 then return false; end if;
  update financial_invoice_intake_limits set attempts=attempts+1 where day=current_day and bucket in ('global',bucket_key);
  return true;
end;
$$;
revoke all on function public.reserve_invoice_intake(text) from public,anon,authenticated;
grant execute on function public.reserve_invoice_intake(text) to service_role;
notify pgrst,'reload schema';
commit;