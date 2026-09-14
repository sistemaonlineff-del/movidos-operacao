-- A importação do histórico financeiro interpretou nomes de pessoas como
-- parceiros. Todo valor fora das duas transportadoras veio daquele arquivo
-- de fechamento iMile e deve voltar ao parceiro operacional correto.
update public.drops
set partner = 'IMILE DELIVERY BRAZIL LTDA'
where partner is not null
  and btrim(partner) <> ''
  and partner not in ('IMILE DELIVERY BRAZIL LTDA', 'J&T EXPRESS LTDA');

alter table public.drops
  drop constraint if exists drops_partner_check;

alter table public.drops
  add constraint drops_partner_check
  check (
    partner is null
    or partner in ('IMILE DELIVERY BRAZIL LTDA', 'J&T EXPRESS LTDA')
  );
