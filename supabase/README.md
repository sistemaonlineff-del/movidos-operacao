# Migração do Access para Supabase

## Atualização de 12/10/2026

**Base existente: não executar novamente schema ou importação inicial.** SQLs testados localmente, não aplicados à produção. Aplicar pessoalmente no SQL Editor após backup/revisão, antes de publicar.

1. Confirmar pré-requisitos existentes: `financial_views`, campos `is_active`/`deactivated_*`, `drops.registration_type`, `delivery_route_base`, `email_logs`, `app_notes`, helpers `is_active_user`, `is_admin`, `has_module_permission` e `can_manage_delivery_routes`. Se faltarem só colunas logísticas, primeiro [migrations/20260917130000_prepare_financial_logistics_columns.sql](migrations/20260917130000_prepare_financial_logistics_columns.sql). Não reaplicar o antigo backfill de parceiros/referências.
2. [migrations/20261012100000_financial_view_controls.sql](migrations/20261012100000_financial_view_controls.sql): índice passa a incluir referência CNPJ; prevenção de novos fechamentos repetidos; correção/desativação transacional auditada. Nenhuma View é modificada ao instalar. Duplicidades legadas entre Views não são apagadas; novas gravações conflitantes são recusadas.
3. [migrations/20261012110000_registration_route_guards.sql](migrations/20261012110000_registration_route_guards.sql): datas de operação, proteção contra novos cadastros/endereços repetidos e limpeza auditada de CEPs selecionados. Não apaga registros nem limpa CEPs na instalação. Datas antigas não são validadas retroativamente; novas gravações precisam respeitar a ordem.
4. [migrations/20261012120000_financial_invoices.sql](migrations/20261012120000_financial_invoices.sql): solicitações/arquivos, bucket privado, reservas limitadas/únicas e revogação em alterações de período. Tabelas de NF não permitem acesso direto anônimo/autenticado; a API confere permissões financeiras e usa service_role só no servidor. Política restritiva protege o bucket mesmo diante de regras antigas permissivas. Não tornar público.
5. Confirmar [migrations/20260916040000_protect_contract_templates.sql](migrations/20260916040000_protect_contract_templates.sql) e políticas financeiras já aplicadas. Proteção de `contract-templates/` cobre contrato e distrato. Nenhuma permissão individual é concedida pelos novos SQLs.

Os três novos arquivos são transacionais/repetíveis. RPCs exigem sessão e permissão; não são chamadas automaticamente na instalação. Auditoria guarda motivo/autor/data; limpeza de CEP guarda os valores anteriores. NFs de fechamentos desativados continuam disponíveis em Notas fora da base ativa.

### Período 35

**35. 2Q DE SETEMBRO não foi alterado nesta entrega.** Após implantar, selecionar a View correta e usar **Corrigir período** para `35. 1Q DE SETEMBRO`, com motivo. Mantém valores/vínculos sem duplicar importação. E-mails registrados bloqueiam renomeação para conferência humana; não apagar logs para contornar.

Para reimportar deliberadamente, usar **Excluir view**, conferir a saída dos totais e só então importar o arquivo correto. Exclusão lógica/transacional preserva histórico. Importação comum permanece sequencial; falha posterior identifica View incompleta e exige conferência antes de repetir. **Substituir base financeira** desativa toda a base ativa e não deve ser usada para corrigir uma quinzena.

### Conferência somente leitura

```sql
select indexname,indexdef from pg_indexes
where schemaname='public' and tablename='financial_periods';
select to_regprocedure('public.change_financial_view(uuid,text,text,text,text)'),
			 to_regprocedure('public.clear_route_postal_codes(uuid[],text)');
select id,name,public,file_size_limit,allowed_mime_types
from storage.buckets where id='financial-invoices';
select column_name,data_type from information_schema.columns
where table_schema='public' and table_name='drops'
	and column_name in ('operation_started_at','operation_ended_at');
```

Bucket deve estar privado, com 3145728 bytes e PDF/XML. Conferir permissões de gerente e leitor financeiro. Homologar com dados fictícios em ambiente autorizado: fechamento por empresa, link/recebimento/revogação, notas arquivadas, correção/desativação e cancelamento da limpeza de CEP. Deploy não executa migrações.

## Instalação inicial

1. No Supabase, abra **SQL Editor** e execute o conteúdo de `schema.sql`, seguido de `02_post_schema.sql`.
2. No computador local, execute `./supabase/export_access.ps1`. A exportação é somente leitura e gera os JSONs de conferência em `supabase/staging`.
3. Após criar uma conta pelo sistema, no SQL Editor execute (trocando pelo e-mail utilizado):

```sql
update public.user_profiles set role = 'admin' where email = 'seu-email@empresa.com';
```

4. A importação definitiva será executada por `python .\\supabase\\import_to_supabase.py`, usando a **Secret key** somente como variável temporária da sessão, nunca em arquivo ou no front-end.

As tabelas estão protegidas por RLS. A chave `publishable` fica apenas no front-end; a chave `secret` fica apenas no processo de migração/backend.

## Erro ao importar fechamento: coluna logística ausente

Em 17/09/2026, a consulta somente leitura do incidente de **34. 2Q DE AGOSTO** confirmou `42703: column financial_periods.logistics_partner does not exist`. A coluna logística também estava ausente em `financial_payment_history`. As duas tentativas visíveis criaram Views em `rascunho`, sem períodos vinculados; a consulta não encontrou períodos 34. Nenhum dado de produção foi alterado no diagnóstico.

Executar [migrations/20260917130000_prepare_financial_logistics_columns.sql](migrations/20260917130000_prepare_financial_logistics_columns.sql) no SQL Editor do Supabase. É uma correção aditiva: inclui as colunas logísticas previstas e `financial_periods.responsible` apenas se faltarem, e solicita recarga do schema PostgREST. Não atualiza parceiros, responsáveis, valores, referências, datas, Views ou políticas. Pode ser repetida e preserva valores já preenchidos. Não reaplicar a migração antiga `20260916011000_financial_logistics_partner.sql` apenas para resolver esse erro: ela também reescreve referências e complementa registros históricos.

Conferência após o SQL:

```sql
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
	and ((table_name in ('financial_periods', 'financial_payment_history', 'loss_events')
				and column_name = 'logistics_partner')
			 or (table_name = 'financial_periods' and column_name = 'responsible'))
order by table_name, column_name;
```

A interface confere as colunas de importação e consulta valores acordados antes de criar a View. Erros retornados como objetos do Supabase agora exibem mensagem, código e etapa. O mesmo arquivo pode ser selecionado de novo após uma falha. Se uma etapa posterior falhar, o aviso identifica a View possivelmente incompleta: conferir o que foi salvo antes de reenviar. A importação continua usando requisições separadas, não uma transação única; não há exclusão nem repetição automática. Os dois rascunhos antigos foram preservados e não são completados automaticamente pelo SQL. Aplicar a correção, conferir os registros e fazer uma única nova tentativa; a planilha real do incidente não foi fornecida para validação local. Merge/deploy não executam este SQL.

## Erro de RLS ao cadastrar funcionário

`new row violates row-level security policy for table "employees"` significa que a política do banco negou a criação. As correções de campos vazios do formulário não removem esse bloqueio. Não desative RLS, não coloque a chave de serviço no navegador e não transforme a conta em administrador apenas para contornar o erro.

### Diagnóstico somente leitura

Um administrador do projeto deve executar estas consultas no SQL Editor do Supabase. Substitua `EMAIL_DA_CONTA` pelo login da pessoa que recebeu o erro, não pelo administrador que está fazendo o diagnóstico. Não é necessário compartilhar senhas, tokens ou documentos de funcionários.

```sql
select profile.email, profile.role, profile.is_active,
	   coalesce(permission.funcionarios_view, false) as funcionarios_view,
	   coalesce(permission.funcionarios_manage, false) as funcionarios_manage
from public.user_profiles as profile
left join public.user_module_permissions as permission on permission.user_id = profile.id
where lower(profile.email::text) = lower('EMAIL_DA_CONTA');

select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename in ('employees', 'employee_dependents')
order by tablename, policyname;

select to_regprocedure('public.is_active_user()') as active_helper,
	   to_regprocedure('public.has_module_permission(text)') as permission_helper;
```

- Conta inexistente, inativa ou sem `funcionarios_manage` (e sem papel `admin` ativo): o bloqueio é esperado. O responsável deve avaliar em **Configurações** se a pessoa deve receber **Ver Funcionários** e **Gerenciar Funcionários**. Não conceder automaticamente.
- Conta ativa autorizada, mas somente políticas legadas `employees_admin_only`/`employee_dependents_admin_only` ou ausência das políticas de gravação: restaurar as regras de módulo conforme abaixo. O teste local reproduz o mesmo erro para um gestor autorizado sob a política legada; isso não confirma quais políticas estão hoje no banco real.
- Políticas de módulo já corretas: não remover restrições adicionais. Conferir a sessão da pessoa, as funções auxiliares e eventuais políticas restritivas personalizadas. Sair e entrar atualiza a sessão, mas não conserta políticas ausentes.

### Recuperação das políticas de módulo

Depois de confirmar a divergência, executar [migrations/20260916050000_restore_employee_module_policies.sql](migrations/20260916050000_restore_employee_module_policies.sql) no SQL Editor. Se apenas `has_module_permission(text)` estiver ausente, primeiro executar [migrations/20260916015000_restore_permission_helper.sql](migrations/20260916015000_restore_permission_helper.sql). Não reaplicar os scripts completos de instalação como reparo: eles contêm operações de inicialização e concessão de acesso para outros módulos.

A migração é transacional e pode ser repetida. Substitui somente os nomes de políticas padrão de funcionários e dependentes; mantém RLS habilitada, políticas adicionais, funções, contas, permissões individuais, dados e gatilhos de auditoria. Usuários ativos com `funcionarios_view` podem consultar; usuários ativos com `funcionarios_manage` e administradores ativos podem consultar, inserir e atualizar. A leitura para quem gerencia permite confirmar o registro devolvido pelo salvamento. Não cria política de exclusão física; a desativação continua por atualização com motivo.

Reexecutar a consulta de políticas e testar com a conta que recebeu o erro. Merge/deploy não executam este SQL. Esta migração foi validada localmente, mas não foi aplicada ao banco de produção nesta correção; a conta e as políticas da tentativa original ainda precisam ser confirmadas.
