# Migração do Access para Supabase

1. No Supabase, abra **SQL Editor** e execute o conteúdo de `schema.sql`, seguido de `02_post_schema.sql`.
2. No computador local, execute `./supabase/export_access.ps1`. A exportação é somente leitura e gera os JSONs de conferência em `supabase/staging`.
3. Após criar uma conta pelo sistema, no SQL Editor execute (trocando pelo e-mail utilizado):

```sql
update public.user_profiles set role = 'admin' where email = 'seu-email@empresa.com';
```

4. A importação definitiva será executada por `python .\\supabase\\import_to_supabase.py`, usando a **Secret key** somente como variável temporária da sessão, nunca em arquivo ou no front-end.

As tabelas estão protegidas por RLS. A chave `publishable` fica apenas no front-end; a chave `secret` fica apenas no processo de migração/backend.

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
