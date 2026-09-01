# Migração do Access para Supabase

1. No Supabase, abra **SQL Editor** e execute o conteúdo de `schema.sql`, seguido de `02_post_schema.sql`.
2. No computador local, execute `./supabase/export_access.ps1`. A exportação é somente leitura e gera os JSONs de conferência em `supabase/staging`.
3. Após criar uma conta pelo sistema, no SQL Editor execute (trocando pelo e-mail utilizado):

```sql
update public.user_profiles set role = 'admin' where email = 'seu-email@empresa.com';
```

4. A importação definitiva será executada por `python .\\supabase\\import_to_supabase.py`, usando a **Secret key** somente como variável temporária da sessão, nunca em arquivo ou no front-end.

As tabelas estão protegidas por RLS. A chave `publishable` fica apenas no front-end; a chave `secret` fica apenas no processo de migração/backend.
