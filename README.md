# Movidos — Operação Integrada

Aplicação que substitui o sistema Excel/VBA + Access por React/Vite, Flask e Supabase.

## Primeira entrega

- Login seguro via Supabase Auth e recuperação de senha por e-mail.
- Painel com indicadores operacionais.
- Cadastro, busca, edição e status de Drops.
- Estrutura segura no Supabase para financeiro, extravios, anexos, e-mails e auditoria.

## Configuração local

1. Crie um projeto no Supabase e rode `supabase/schema.sql` no SQL Editor.
2. Copie `.env.example` para `.env.local` e preencha apenas a URL e a chave anônima do Supabase.
3. Execute `npm install` e `npm run dev`.
4. Para o backend, copie `backend/.env.example` para `backend/.env`, instale `backend/requirements.txt` e execute `python backend/app.py`.

## Publicação

O frontend está pronto para Vercel. Cadastre no projeto Vercel as variáveis `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`; nunca publique uma chave `service_role` no frontend.

## Migração

A base Access foi inventariada e contém 1.102 Drops, 1.623 itens financeiros, 4.154 extravios e 480 registros de e-mail. A importação será feita apenas após a criação do projeto Supabase, para não expor nem duplicar dados.
