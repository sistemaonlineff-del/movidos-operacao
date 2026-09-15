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

## Revisão do documento Movidos (15/09/2026)

- Contratos usam a data selecionada no cadastro. Distratos incluem as datas e o motivo preenchido; salvar o cadastro persiste esses campos. O rascunho em Mensagens prontas já possui salvamento e foi validado após recarregar a página.
- A câmera aceita capturas consecutivas com até 20 fotos pendentes e três leituras simultâneas, em ordem de captura. A fila não pode ser apagada enquanto está processando. Falhas na gravação da pré-rota ficam visíveis; fotos da fila permanecem apenas na sessão da página.
- Pagamento Detalhes separa Responsável e Parceiro. `logistics_partner` representa o parceiro logístico; o campo antigo `partner` dos períodos é preservado para não fundir períodos históricos nem alterar seus vínculos. A migração atribui IMILE aos registros existentes e MOVIDOS à referência financeira, sem modificar o CNPJ/CPF real dos drops.
- O modelo baixado na importação inclui a aba **Pagamento Total**. Preencher uma linha por parceiro, com `TotalLiquidoAReceber` e `DataPagamento`. Zero é aceito; valores ausentes, datas inválidas e parceiros duplicados são rejeitados antes de importar. O resumo é salvo uma única vez por período/parceiro.
- W2D soma PUDO Missing e PUDO Missing - não cobrei; D2D soma D2D Missing e D2D Missing - não cobrei. Total de extravios = W2D + D2D; bruto = líquido informado + extravios. Pagamento aos drops = soma de Total a receber; Talita e Jorge = líquido - pagamento aos drops. Reembolso erro iMile é apenas registro no Pagamento Total. Líquido não informado não é estimado.
- CNAB aceita datas nativas do Excel (calendários 1900 e 1904), texto brasileiro e ISO, validando o calendário.
- Mensagens prontas consulta apenas chaves `ready-message-%`. A proteção de modelos, logs e anotações financeiras também depende das políticas SQL abaixo.

### Aplicação no Supabase

Antes de publicar o frontend, aplicar em ambiente autorizado, após backup e revisão, as migrações pendentes em ordem. Não executar novamente o schema inicial na base existente.

1. Confirmar que `20260915094000_persist_ready_message_draft.sql` já foi aplicada.
2. Aplicar `20260916010000_isolate_financial_emails.sql` para restringir leitura/escrita financeira no banco.
3. Aplicar `20260916011000_financial_logistics_partner.sql` para criar os campos e atualizar as referências financeiras existentes, sem remover registros.

As duas novas migrações foram testadas em PostgreSQL local em memória, **não aplicadas ao Supabase de produção**. A filtragem na interface sozinha não substitui a política de acesso do banco. A importação e edição que usam os novos campos precisam da migração antes do uso real.

### Validação local

- `npm test`: cálculos, planilhas, CNAB e migrações/RLS em PostgreSQL em memória.
- `npm run build`: TypeScript e bundle de produção.
- Com `npm run dev -- --host 127.0.0.1` na porta 5173 e Microsoft Edge instalado, executar `npm run test:browser`. O teste usa sessão fictícia, câmera simulada e intercepta todas as chamadas externas; não grava dados reais. Capturas e PDFs ficam em `tmp/browser-tests`, fora do Git.
- A aplicação interativa local continua apontando para o Supabase configurado em `src/lib/supabase.ts`. Não usar registros reais como dados de teste. As APIs Vercel `/api/label-*` não são servidas pelo Vite; o OCR e a pré-rota reais exigem o backend configurado. Os testes de câmera validam a fila e os resultados com respostas simuladas, não a precisão do OCR real.

### Leitor na prévia local

O Vite não executa as funções Vercel. Sem backend, as rotas do leitor retornam JSON com status 503 e uma mensagem de configuração, sem tentar carregar o código da API como frontend.

Para usar um backend publicado autorizado, definir `MOVIDOS_BACKEND_URL` em `.env.local` com a origem HTTPS oficial (sem `/api`, parâmetros ou credenciais) e reiniciar o Vite. Somente `/api/label-routes`, `/api/label-read` e `/api/label-volume` são encaminhadas. A autenticação existente é mantida e o TLS é validado; não colocar chaves Gemini ou service_role em variáveis `VITE_*`.

A sessão será encaminhada ao backend escolhido. Capturar etiquetas pode consumir a API de OCR e gravar pré-rotas nesse ambiente. Não apontar para produção sem autorização. Nenhum endereço remoto foi configurado automaticamente.

As funções do leitor dependem de `server/label-auth.ts`, incluído no projeto e resolvido pelos imports `.js` durante a compilação. O módulo valida o token no Supabase, o perfil ativo e a permissão `label_reader_access`; administradores ativos têm acesso. O backend requer `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`, e o OCR requer `GEMINI_API_KEY`, somente no servidor. `npm test` também compila e carrega as três APIs e valida a autorização com chamadas simuladas, sem consumir OCR nem gravar volumes. O build do frontend sozinho não valida essas funções.
