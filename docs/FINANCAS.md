# Financas Privadas Embedded

Implementacao local a partir de `Movidos-Financeiro`, com integracao completa no aplicativo raiz e dependencias instaladas. O build raiz, os 26 testes dedicados e os dois harnesses browser passaram. Isso nao significa implantacao ou homologacao em producao: nao houve execucao de SQL no Supabase real, escrita de producao, importacao automatica de dados locais nem copia de `.local` ou arquivos privados para `public`.

## Integracao No Aplicativo Raiz

`src/App.tsx` ja integra `/financas/*` ao Router e ao shell autenticado existentes, com `FinancasGate`. O gate usa `canAccessFinancas` de `src/financasAccess.ts`, a partir do e-mail e de `is_active` do perfil: somente Fabio (`fabioaf9@gmail.com`) e Talita (`talitapreviatti@gmail.com`), com perfil ativo, podem acessar. Outro administrador nao recebe bypass; perfil inativo tambem nao acessa. O menu externo respeita a mesma permissao, e o gate protege inclusive o acesso direto pela URL. Essa protecao cliente nao substitui o RLS.

O componente default de `src/financas/App.tsx` reutiliza o React Router e a sessao Supabase do sistema, sem outro BrowserRouter, login, logout, sidebar ou topbar. Fornece somente a subnav local, o conteudo e seus dialogs. Os `Route path` internos sao relativos; links e atalhos sao ancorados em `/financas` para evitar acumulacao de segmentos sob splat no Router 7.

As dependencias `lucide-react`, `papaparse`, `recharts`, `@fontsource/dm-sans` e `@types/papaparse` estao instaladas no destino. Recharts esta em **3.10.1**, a mesma versao da fonte. React, React DOM, React Router e Supabase sao os do sistema. A fonte DM Sans e carregada localmente por `@fontsource/dm-sans`, sem Google Fonts.

`src/main.tsx` importa `finance-theme.css` por ultimo. Esse tema inclui alteracoes esteticas globais no shell e nas telas existentes; nao e correto afirmar que toda a mudanca visual esta isolada no modulo. As regras internas do modulo continuam escopadas conforme descrito abaixo.

**Compatibilidade de imports:** os imports de runtime de `csv.ts` e `cnab.ts` usam `./domain`, sem extensao, para compatibilidade com o build raiz. Essa e somente uma adaptacao de resolucao de modulo; as formulas foram preservadas. O teste estrutural normaliza essa diferenca de import na comparacao com a fonte. Nao e necessario habilitar opcao TypeScript adicional para esses imports.

O store reutiliza exclusivamente `src/lib/supabase.ts`, no mesmo projeto Supabase ja usado pelo sistema. Nao ha `/api/local`, novo cliente, novo workspace configuravel por env ou login independente. Nao sao necessarios novas variaveis de ambiente, nova conta ou novo projeto Supabase. Falha de leitura remove o conteudo antigo e oferece nova tentativa. Falha de escrita preserva o formulario; conflito exige atualizar e revisar. Em resposta perdida, confira a revisao e a base antes de repetir, pois a gravacao pode ter sido confirmada no servidor.

## Telas E Fidelidade

| Rota | Funcionalidade herdada |
| --- | --- |
| `/financas` | Indicadores, graficos, ultimos lancamentos e atalhos |
| `/financas/caixa` | Filtros, busca, todas as competencias, paginacao, CRUD, CSV e duplicatas |
| `/financas/planejamento` | Planejamento por competencia, zero/null, vencimento e receita vinculada ao realizado |
| `/financas/analise` | Planejado x realizado, agrupamento, filtro e exportacao CSV |
| `/financas/projecao` | Projecao mensal, saldo inicial e ajustes assinados |
| `/financas/categorias` | Catalogo, subcategorias, descricoes, cadastro e busca |
| `/financas/pagamentos` | CRUD, selecao, remessa CNAB Inter em homologacao e sequencial |
| `/financas/auditoria` | Ocorrencias e metadados da origem, com filtro |
| `/financas/configuracoes` | Empresa pagadora, transferencias, exportacao e restauracao JSON |

`domain.ts` e identico a fonte, descontando finais de linha; `csv.ts` e `cnab.ts` preservam a logica original, com somente o import de runtime `./domain` sem extensao. O teste estrutural normaliza esse import. Onze componentes de tela/editor tambem passam em comparacao AST com a fonte, admitindo apenas os dois atalhos para `/financas/caixa`. Nao foram alteradas formulas, classificacoes, sinais, centavos, vinculos ou projecoes. Adaptacoes: integracao e gate raiz, shell, store, portal escopado e restauracao de envelope.

Todos os seletores internos de `src/financas/styles.css` e `projection.css`, inclusive media queries e backdrop, comecam por `.financas-module`. As regras do shell standalone removido nao foram mantidas. Dialogs usam portal em `document.body` com ancestral `.financas-module.financas-portal`; o dialog conserva tipografia e variaveis sem aplicar essas regras internas a `body`, `:root` ou `#root`. Esse isolamento nao se estende ao tema raiz `src/finance-theme.css`, que altera a estetica global e a tipografia do shell com a fonte local.

## Aplicacao Manual Do SQL

Ha **um unico arquivo SQL** novo: `supabase/migrations/20261108120000_private_finances.sql`. O responsavel deve revisar o backup e executa-lo manualmente, como administrador de banco autorizado, no mesmo projeto Supabase existente. Sao exigidos a estrutura Supabase Auth e os perfis existentes em `public.user_profiles(id,is_active)` para as contas autorizadas. O SQL ainda nao foi executado no projeto real.

Antes de qualquer DDL, a transacao trava `auth.users` em SHARE e verifica separadamente os e-mails **exatos** `fabioaf9@gmail.com` e `talitapreviatti@gmail.com`: cada um deve existir uma unica vez e possuir `email_confirmed_at`. Ausencia, duplicidade, diferenca de caixa ou conta nao confirmada abortam antes de criar objetos. Nao cria contas nem ativa perfis.

Namespace coordenado: `financas_workspaces`, `financas_members`, `financas_books`, `financas_history`; RPC `financas_save_book`; helper `financas_is_member`. Singleton estavel: `f1082026-1108-4000-8000-000000000001`, igual ao store. Provisiona membership editor para os UUIDs encontrados no Auth e um livro exatamente igual a `emptyState()`, com revisao zero. Nao carrega dados privados. `ON CONFLICT DO NOTHING` preserva livro, revisoes, historico e memberships existentes na reaplicacao.

O helper SECURITY DEFINER verifica ao mesmo tempo membership editor, `auth.uid()`, e-mail **atual de auth.users** na allowlist, conta confirmada e perfil `is_active = true`. Nao usa e-mail do JWT nem permite bypass por role ADMIN. Leitura das quatro tabelas depende desse helper; membership so mostra a propria linha. Clientes nao recebem INSERT, UPDATE, DELETE ou gestao de membership. O unico caminho de escrita e a RPC autenticada, que revalida permissao, rejeita revisao null/negativa e payload invalido, trava o livro com FOR UPDATE, verifica revisao, arquiva o estado anterior e atualiza atomicamente. Dados e historico legado `financial_*`, DROPs, fechamentos e seus policies nao sao alterados.

Isso protege usuarios da aplicacao, inclusive administradores do sistema. Nao promete proteger contra superusuario de PostgreSQL, dono das tabelas ou credenciais service-role; esses poderes administrativos continuam fora do modelo RLS e devem ser restritos operacionalmente.

## Migracao Dos Dados Locais

1. Na aplicacao **fonte**, abra Configuracoes e use **Exportar copia da base**. Esse JSON representa os dados carregados de `.local/database.json`, inclusive alteracoes locais. Nao use o seed antigo nem gere novamente a migracao por cima de edicoes.
2. Aplique manualmente o unico SQL novo no mesmo Supabase. A integracao raiz e as dependencias ja estao prontas. Entre pelo login existente como uma das contas autorizadas, com perfil ativo.
3. Em `/financas/configuracoes`, exporte a base atual antes de substituir. Escolha **Restaurar / migrar base** e selecione o JSON exportado da fonte.
4. Confira a quantidade de lancamentos/planejamentos na confirmacao. A restauracao substitui o estado inteiro; nao faz merge. O servidor preserva o livro anterior no historico privado.
5. Atualize/reabra e confira auditoria, valores, planejamentos, pagamentos e projecao. A revisao de destino incrementa normalmente; nao reutiliza a revisao da origem.

Os dados locais nao sao importados automaticamente nem copiados para `public`. Mantenha o export da base ativa em local privado e restaure-o explicitamente pela mesma UI em `/financas/configuracoes`, depois do SQL e do backup do destino.

Aceita o estado puro exportado pela UI da fonte e o envelope do projeto `{ "revision": 12, "data": { ...FinancialState }, "updatedAt": "..." }`, inclusive a estrutura de `.local/database.json` caso o responsavel a selecione explicitamente. O envelope requer revisao inteira nao negativa e updatedAt string. Somente `data` e restaurado; nao copia tokens ou campos de persistencia. A UI valida antes de confirmar, e o SQL valida novamente. Limite do arquivo e do payload JSONB: 15 MiB; a representacao JSONB pode exceder o tamanho de um arquivo compactado.

## Validacao E Limites

Validacao local concluida: **build raiz aprovado, 26 testes dedicados aprovados, browser standalone aprovado e integracao mock do aplicativo real aprovada**. Os comandos abaixo usam as dependencias instaladas no destino, Node 24 e Edge/Playwright, a partir da raiz do projeto:

```powershell
npm.cmd run build
node --import ./tests/financas-loader.mjs --test --test-concurrency=1 "tests/financas-*.test.mjs"
node --import ./tests/financas-loader.mjs tests/financas-browser.mjs
node --import ./tests/financas-loader.mjs tests/financas-app-browser.mjs
```

O loader e o nodePaths dos harnesses sao exclusivamente de teste, nao entram no app. Nao e necessario configurar env de dependencias externas. O harness standalone compila em memoria, substitui somente o cliente compartilhado por um falso e usa fixtures sinteticas; bloqueia rede externa e nao le arquivos privados. `node --import ./tests/financas-loader.mjs tests/financas-browser.mjs --serve` abre esse mesmo harness seguro em porta dinamica loopback para inspecao, nao a aplicacao real.

Cobertura dedicada: testes adaptados completos de dominio/CSV/CNAB; backup puro/envelope; store/sessao/RPC/historico; CSS/fidelidade/typecheck; PGlite com preflight ausente/duplicado/nao confirmado, Fabio/Talita editores, outro ADMIN, anon, perfil ausente/inativo, membership injetada, e-mail alterado, writes diretos negados, payloads principais invalidos, limite, conflito/null, historico preservado, reaplicacao e sentinela `financial_history` intocada. Browser standalone: nove rotas, atalhos, CRUD de caixa, falha/retry, conflito, CSV/reimportacao/export, planejamento, projecao, CNAB, categorias, auditoria, export/restore, portal e isolamento dos estilos internos em 1440/390/360 px.

`tests/financas-app-browser.mjs` valida a integracao no aplicativo real, com cliente Supabase mock e rede externa bloqueada: **6 contextos e 18 navegacoes de Financas**, cobrindo Fabio, Talita, outro administrador e perfil inativo, em desktop **1440 px** e mobile **390 px**. Verifica menu/gate, navegacao das telas e preservacao do viewport global **980**. Usa **2 cadastros sinteticos**; nao importa a base privada nem realiza escritas em producao. Esse teste inclui o shell e o tema raiz, diferentemente do standalone.

Limites herdados, deliberadamente nao completados neste trabalho:

- CNAB continua **somente homologacao**, sem envio, liquidacao, retorno bancario, verificacao dos digitos CPF/CNPJ ou certificacao do Inter.
- Catalogo conserva somente cadastro/busca da fonte, sem adicionar rename/delete de categorias. Nao foi criado gerenciador de ano novo nem novos recursos ausentes na fonte.
- Persistencia e um livro JSONB inteiro com limite 15 MiB e revisao global: edicoes independentes podem conflitar. Historico armazena copias completas, sem retencao automatica. A exclusao remove da base ativa, nao do historico.
- SQL valida o dominio principal: tipos/IDs unicos, datas reais, classificacao, centavos/limites, planejamento, competencias, ajustes, banco/sequencia, catalogo e metadados. Nao equivale a validacao bancaria/fiscal ou auditoria da planilha. Campos extras e metadados secundarios como sourceRow nao recebem um schema fechado; nomes de origem/hash/data de importacao sao strings, sem autenticacao de procedencia. Esse limite tambem existe no validateState original.
- Importacao CSV nao executa macros Excel; restauracao JSON nao verifica que os valores vieram de uma planilha genuina. Ocorrencias da origem continuam exigindo revisao humana.
- Nao houve teste com sessoes de usuarios reais, execucao de SQL no Supabase real nem concorrencia real multiusuario. Build e integracao raiz foram validados localmente com mocks/PGlite; nao comprovam RLS implantado, desempenho de bases grandes, compatibilidade de todos os dispositivos ou homologacao de producao. Aplicacao manual do SQL, restauracao privada da base ativa e homologacao no ambiente real continuam a cargo do responsavel.

## Arquivos Entregues

Modulo: `src/financas/App.tsx`, `backup.ts`, `cnab.ts`, `csv.ts`, `domain.ts`, `store.ts`, `styles.css`, `projection.css`.

SQL: `supabase/migrations/20261108120000_private_finances.sql`.

Testes: `tests/financas-domain.test.mjs`, `financas-csv.test.mjs`, `financas-cnab.test.mjs`, `financas-backup.test.mjs`, `financas-database.test.mjs`, `financas-store.test.mjs`, `financas-structure.test.mjs`, `financas-loader.mjs`, `financas-browser.mjs`.

Integracao raiz: `src/App.tsx`, `src/financasAccess.ts`, `src/main.tsx`, `src/finance-theme.css`, dependencias do projeto e `tests/financas-app-browser.mjs`. A integracao inclui mudancas de CSS global; nao altera as tabelas existentes do Supabase.

Documentacao: este `docs/FINANCAS.md`. Esta atualizacao documental edita somente esse arquivo, sem operacoes Git ou alteracoes em outros arquivos.