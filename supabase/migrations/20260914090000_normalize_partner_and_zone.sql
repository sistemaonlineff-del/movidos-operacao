-- Mantém filtros e cadastros com uma única opção para cada parceiro e zona.
update public.drops
set partner = case
  when partner ~* 'imile' then 'IMILE DELIVERY BRAZIL LTDA'
  when partner ~* 'j[[:space:]]*&[[:space:]]*t' then 'J&T EXPRESS LTDA'
  else btrim(partner)
end,
zone = case upper(btrim(zone))
  when 'FORA SP' then 'FORA DE SP'
  else upper(btrim(zone))
end
where partner is not null or zone is not null;

update public.financial_periods
set partner = case
  when partner ~* 'imile' then 'IMILE DELIVERY BRAZIL LTDA'
  when partner ~* 'j[[:space:]]*&[[:space:]]*t' then 'J&T EXPRESS LTDA'
  else btrim(partner)
end
where partner is not null;

update public.loss_events
set partner = case
  when partner ~* 'imile' then 'IMILE DELIVERY BRAZIL LTDA'
  when partner ~* 'j[[:space:]]*&[[:space:]]*t' then 'J&T EXPRESS LTDA'
  else btrim(partner)
end
where partner is not null;

update public.financial_payment_history
set partner = case
  when partner ~* 'imile' then 'IMILE DELIVERY BRAZIL LTDA'
  when partner ~* 'j[[:space:]]*&[[:space:]]*t' then 'J&T EXPRESS LTDA'
  else btrim(partner)
end
where partner is not null;

update public.email_logs
set partner = case
  when partner ~* 'imile' then 'IMILE DELIVERY BRAZIL LTDA'
  when partner ~* 'j[[:space:]]*&[[:space:]]*t' then 'J&T EXPRESS LTDA'
  else btrim(partner)
end
where partner is not null;
