begin;

create temporary table historical_net_recovery (label text primary key, invoice numeric(14,2), payment_date date, source_line integer) on commit drop;
insert into historical_net_recovery values
('01. 1Q DE ABRIL',4999.25,'2025-05-16',3),
('02. 2Q DE ABRIL',6272.96,'2025-06-01',4),
('03. 1Q DE MAIO',18059.95,'2025-06-16',5),
('04. 2Q DE MAIO',21223.62,'2025-07-01',6),
('05. 1Q DE JUNHO',25550.75,'2025-07-16',7),
('06. 2Q DE JUNHO',34627.88,'2025-08-01',8),
('07. 1Q DE JULHO',35235.80,'2025-08-16',11),
('08. 2Q DE JULHO',28868.03,'2025-09-01',12),
('09. 1Q DE AGOSTO',35702.50,'2025-09-16',13),
('10. 2Q DE AGOSTO',29538.25,'2025-10-01',14),
('11. 1Q DE SETEMBRO',41927.52,'2025-10-16',15),
('12. 2Q DE SETEMBRO',38032.04,'2025-11-01',16),
('13. 1Q DE OUTUBRO',45120.49,'2025-11-16',17),
('14. 2Q DE OUTUBRO',45272.70,'2025-12-01',18),
('15. 1Q DE NOVEMBRO',66886.69,'2025-12-05',19),
('16. 2Q DE NOVEMBRO',62083.28,'2025-12-16',20),
('17. 1Q DE DEZEMBRO',99535.89,'2026-01-02',21),
('18. 2Q DE DEZEMBRO',46622.48,'2026-01-16',22),
('19. 1Q DE JANEIRO',55563.55,'2026-02-16',23),
('20. 2Q DE JANEIRO',47853.35,'2026-03-01',24),
('21. 1Q DE FEVEREIRO',52476.42,'2026-03-16',25),
('22. 2Q DE FEVEREIRO',45392.87,'2026-04-06',26),
('23. 1Q DE MARÇO',64549.35,'2026-04-16',27),
('24. 2Q DE MARÇO',90957.14,'2026-05-02',28),
('25. 1Q DE ABRIL',95772.39,'2026-05-16',29),
('26. 2Q DE ABRIL',85894.73,'2026-06-06',30),
('27. 1Q DE MAIO',108811.87,'2026-06-16',31),
('28. 2Q DE MAIO',95417.36,'2026-07-06',32),
('29. 1Q DE JUNHO',140521.01,'2026-07-16',33),
('30. 2Q DE JUNHO',115903.59,'2026-08-06',34),
('31. 1Q DE JULHO',159625.76,'2026-08-16',35),
('32. 2Q DE JULHO',152863.92,'2026-09-10',36),
('33. 1Q DE AGOSTO',153227.51,'2026-09-16',37);

do $$
declare
  payment record;
  target public.financial_views%rowtype;
  metadata jsonb;
  summary jsonb;
  matched integer;
begin
  if not exists (select 1 from public.financial_views where is_active and source_file_name = '0000 - CONTROLE FINANCEIRO com macro.xlsx') then return; end if;
  lock table public.financial_views in share row exclusive mode;
  lock table public.financial_periods in share mode;
  for payment in select * from historical_net_recovery order by label loop
    select count(*) into matched from public.financial_views where is_active and title = payment.label and source_file_name = '0000 - CONTROLE FINANCEIRO com macro.xlsx';
    if matched <> 1 then raise exception 'Historico ausente ou duplicado: %', payment.label; end if;
    select * into strict target from public.financial_views where is_active and title = payment.label and source_file_name = '0000 - CONTROLE FINANCEIRO com macro.xlsx';
    if not exists (select 1 from public.financial_periods where is_active and financial_view_id = target.id)
      or exists (select 1 from public.financial_periods where is_active and financial_view_id = target.id and (label <> payment.label or net_amount is not null or (payment_date is not null and payment_date <> payment.payment_date)))
    then raise exception 'Periodos sem vinculo ou com valores a conferir: %', payment.label; end if;
    begin
      metadata := target.notes::jsonb;
    exception when invalid_text_representation then
      metadata := null;
    end;
    if jsonb_typeof(metadata) is distinct from 'object' then metadata := jsonb_build_object('originalNotes', target.notes); end if;
    summary := metadata->'summary';
    if summary is null or summary = 'null'::jsonb then summary := '{}'::jsonb; end if;
    if jsonb_typeof(summary) <> 'object' then raise exception 'Resumo invalido: %', payment.label; end if;
    if (summary->>'invoice' is not null and (summary->>'invoice')::numeric <> payment.invoice)
      or (summary->>'paymentDate' is not null and summary->>'paymentDate' <> payment.payment_date::text)
    then raise exception 'Resumo divergente: %', payment.label; end if;
    if summary->>'invoice' is not null and summary->>'paymentDate' is not null then continue; end if;
    update public.financial_views set notes = (metadata || jsonb_build_object(
      'summary', summary || jsonb_build_object('invoice', payment.invoice, 'paymentDate', payment.payment_date::text),
      'historicalPaymentRecovery', jsonb_build_object('source', '0000 - CONTROLE FINANCEIRO com macro.xlsm', 'sha256', 'a7bee06af630bcafe73c936a12acd514a9e817aacc2fe73c2ff25cff00789bac', 'line', payment.source_line)
    ))::text where id = target.id;
  end loop;
end $$;
commit;