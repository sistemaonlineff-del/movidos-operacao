alter table public.financial_periods
  add column if not exists reference_cnpj text;

alter table public.financial_periods
  drop constraint if exists financial_periods_reference_cnpj_check;

alter table public.financial_periods
  add constraint financial_periods_reference_cnpj_check
  check (reference_cnpj is null or reference_cnpj in ('JOTA EXPRESS', 'MOVIDOS', 'BELLY'));

-- Também corrige instalações que já receberam a abreviação temporária dos parceiros.
update public.drops
set partner = case
  when partner ~* 'imile' then 'IMILE DELIVERY BRAZIL LTDA'
  when partner ~* 'j[[:space:]]*&[[:space:]]*t' then 'J&T EXPRESS LTDA'
  else btrim(partner)
end
where partner is not null;

update public.financial_periods
set partner = case
  when partner ~* 'imile' then 'IMILE DELIVERY BRAZIL LTDA'
  when partner ~* 'j[[:space:]]*&[[:space:]]*t' then 'J&T EXPRESS LTDA'
  else btrim(partner)
end
where partner is not null;
