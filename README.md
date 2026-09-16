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

Para usar um backend publicado autorizado, definir `MOVIDOS_BACKEND_URL` em `.env.local` com a origem HTTPS oficial (sem `/api`, parâmetros ou credenciais) e reiniciar o Vite. Somente `/api/label-routes`, `/api/label-read`, `/api/label-volume` e `/api/financial/send-closing` são encaminhadas. A autenticação existente é mantida e o TLS é validado; não colocar chaves Gemini ou service_role em variáveis `VITE_*`.

A sessão será encaminhada ao backend escolhido. Capturar etiquetas pode consumir a API de OCR e gravar pré-rotas nesse ambiente. Não apontar para produção sem autorização. Nenhum endereço remoto foi configurado automaticamente.

As funções do leitor dependem de `server/label-auth.ts`, incluído no projeto e resolvido pelos imports `.js` durante a compilação. O módulo valida o token no Supabase, o perfil ativo e a permissão `label_reader_access`; administradores ativos têm acesso. O backend requer `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`, e o OCR requer `GEMINI_API_KEY`, somente no servidor. `npm test` também compila e carrega as três APIs e valida a autorização com chamadas simuladas, sem consumir OCR nem gravar volumes. O build do frontend sozinho não valida essas funções.

### Recuperação dos Totais Históricos

A migração `supabase/migrations/20260916030000_recover_historical_net.sql` complementa os 33 fechamentos da importação `0000 - CONTROLE FINANCEIRO com macro.xlsx` com líquido e data da aba **Pgto Total** do arquivo original `.xlsm`. Os 33 valores conferidos somam **R$ 2.150.390,90**. O hash SHA-256 da fonte e a linha de origem ficam nas observações estruturadas de cada fechamento; o texto anterior é preservado em `originalNotes`. Linhas futuras sem líquido e linhas adicionais de reembolso não entram na recuperação.

Em 15/09/2026, a complementação equivalente foi aplicada aos 33 registros existentes via sessão administrativa autorizada, com comparação das observações anteriores antes de cada gravação. A releitura confirmou todos os líquidos e a preservação dos demais registros: 1.449 períodos, 1.519 pagamentos históricos, 1.519 itens e 5.299 extravios. Nenhum histórico foi apagado/recriado. O arquivo SQL não foi executado no banco nem registrado automaticamente no controle de migrações; sua execução posterior reconhece os resumos completos e iguais como já recuperados e não os sobrescreve.

O SQL é transacional: exige uma única view por período da fonte histórica, confere os vínculos e rejeita valores/datas conflitantes. Não grava o líquido em cada período de responsável, o que duplicaria o total. Não altera pagamentos de DROPs, extravios ou reembolsos. Em uma base sem essa importação específica, não faz alterações.

O bruto segue a regra atual, **líquido + extravios W2D/D2D dos status definidos**, e Talita/Jorge = líquido - total dos DROPs. Os períodos 01, 02, 03, 04, 05 e 08 têm bruto diferente da coluna antiga da planilha porque seus status legados não entram na regra atual; não foram reclassificados. Exemplo validado no fechamento 33: líquido **R$ 153.227,51**, extravios **R$ 31.349,36**, bruto **R$ 184.576,87**, data **16/09/2026**. A suíte SQL usa o cálculo real da aplicação e testa preservação, repetição sem alterações e rollback por conflito, inclusive líquido zero.

### Last Mile e pagamento total

No formulário comum de cadastro (também usado ao reabrir Last Mile), **Salvar e permanecer** mantém os campos e o ID salvo na URL; novos salvamentos atualizam o mesmo registro. **Salvar e sair** retorna à lista correspondente; na criação esse botão continua chamado **Salvar cadastro**. A mudança para **EXCLUÍDO** exige motivo e grava a desativação lógica, sem excluir o histórico. Os status usam a lista canônica de `dropOptions`, compatível com a restrição SQL, inclusive os acentos de EXCLUÍDO e APROVAÇÃO. Falhas de gravação ficam visíveis e preservam os dados digitados e o motivo. Esta correção de salvamento não exige SQL novo nem altera permissões.

O cadastro Last Mile inclui as mesmas seções de fotos, contratos e distratos do cadastro comum. Os anexos são liberados após salvar, vinculados ao ID salvo e continuam disponíveis ao reabrir o cadastro pela lista. Salvar novamente atualiza o mesmo registro. Administradores ativos também podem baixar o modelo padrão, editar o DOCX externamente, enviar uma versão temporária e restaurar o padrão; o modelo é compartilhado com os demais cadastros, não exclusivo do Last Mile.

Aplicar `supabase/migrations/20260916040000_protect_contract_templates.sql` no Supabase antes de liberar a administração de modelos. A API já restringe as alterações a administradores ativos; a migração adiciona políticas restritivas para criação, atualização e exclusão de objetos da pasta `contract-templates/`, inclusive tentativas diretas fora da tela, sem restringir anexos em `drops/`. Não exclui nem regrava arquivos existentes. O deploy não executa esta migração automaticamente.

Em **Pagamento Total**, usuários ativos com `financeiro_manage` podem editar apenas **Total líquido a receber** e **Data do pagamento** por período/parceiro. Os cálculos de bruto, extravios e pagamento aos DROPs permanecem automáticos. Um período único usa `financial_periods.net_amount/payment_date`; históricos com vários responsáveis e sem líquidos individuais usam o resumo existente da view, desde que ela pertença inteiramente ao mesmo período/parceiro. Outras combinações ambíguas são bloqueadas, sem ratear nem duplicar o líquido. A data do total prevalece sobre datas individuais dos DROPs, que não são alteradas. Metadados históricos são preservados e gravações concorrentes sobre valores modificados são rejeitadas. Não há alteração automática dos dados de produção.

### Envio direto dos fechamentos

Exceção restrita ao teste fictício: depois de **Enviar teste** retornar um registro original `incerto`, o botão passa a **Repetir teste**. Um administrador ativo deve confirmar que conferiu os Enviados e a entrada/spam do destinatário e não encontrou a mensagem. A API aceita `mode: test`, `retryOf: <id original>` e `reconciled: true`, valida o registro original e mantém destino/PDF fixos. Cria uma nova reserva única derivada do ID original (`sha256(mail-test-retry:<id>)`), sem apagar, liberar ou alterar a tentativa anterior. Cliques concorrentes, administradores diferentes e recarregamentos reutilizam a mesma reserva. Uma repetição aceita, incerta ou ainda em andamento não dispara novamente; não é possível encadear repetições. Nenhuma migração adicional é necessária. Isso não libera fechamentos reais nem comprova entrega; aceitação do provedor e recebimento são estados diferentes.

O botão **Verificar conexão** autentica no SMTP com TLS validado, sem chamar `sendMail`, gerar PDF, gravar logs ou alterar reservas. É exclusivo de administrador ativo, funciona sem filtros financeiros e sem depender da migração `email_logs`. A resposta de sucesso confirma somente conexão/autenticação, não entrega, autorização do remetente ou capacidade de aceitar qualquer mensagem. Microsoft Graph não é verificado por esse botão. A tentativa anterior incerta permanece bloqueada, inclusive após redeploy ou diagnóstico bem-sucedido; não remover a reserva sem reconciliação e autorização.

Falhas futuras são traduzidas em categorias fixas (autenticação, conexão, envelope ou mensagem), sem expor respostas brutas, credenciais ou tokens. O registro retém a orientação para consultas posteriores; erros antigos genéricos não permitem recuperar a causa original. **PREPARADO** corresponde a rascunhos legados, não a e-mails enviados. Se `has_module_permission(text)` estiver ausente apesar da tabela de permissões existir, aplicar `20260916015000_restore_permission_helper.sql` antes da migração de envio: ela cria apenas a função ausente, respeita usuários ativos e preserva concessões existentes. Não executada automaticamente pelo frontend/deploy.

O botão **Enviar e-mails** envia um PDF por DROP pelo servidor, após confirmação do período, parceiro, remetente e quantidade. Não baixa `.eml` nem depende do Outlook instalado. O destinatário é consultado no cadastro do DROP pelo servidor; somente administrador ativo ou usuário ativo com `financeiro_manage` pode enviar. A resposta **ACEITO** significa aceitação pelo provedor, não comprovação de entrega na caixa do destinatário.

O botão **Enviar teste** faz um envio real exclusivamente para `fabioaf9@gmail.com`, autorizado para este piloto, sem selecionar DROP, parceiro ou período. Apenas administrador ativo pode executá-lo. Assunto, texto e PDF fictício são gerados no servidor; destinatário e conteúdo enviados pelo navegador não são utilizados. Não consulta dados financeiros nem modifica fechamentos. Registra o teste em `email_logs` e permite uma reserva por dia UTC para esse destinatário, compartilhada entre administradores; repetição não dispara outra mensagem. Envio incerto continua bloqueado. Exige as mesmas credenciais `MAIL_*` e a migração do envio direto; não é uma simulação de entrega. Se `MAIL_TEST_RECIPIENT` estiver definido, precisa corresponder ao endereço autorizado. A confirmação de entrega é feita conferindo a caixa de entrada/spam do destinatário.

Diagnóstico: HTTP 500 com `FUNCTION_INVOCATION_FAILED` e conteúdo não JSON indica falha ao iniciar/executar a função Vercel, não entrega de e-mail. Conferir os logs da função e o deploy. A dependência transitiva `financialData` usa import com extensão `.js` para resolução nativa do Node; a suíte inclui carregamento ESM sem bundler para detectar regressões que o build Vite ou bundle de testes ocultariam. Configuração ausente deve retornar erro JSON 503, e acesso sem sessão deve retornar JSON 401.

Antes de ativar, confirmar a conta remetente e o provedor, publicar via PR e aplicar `20260916020000_direct_closing_email.sql` após as migrações anteriores. A migração é testada localmente, não aplicada automaticamente ao banco real. Configurar `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e as variáveis `MAIL_*` somente no servidor Vercel, nunca no frontend, Git ou conversa. Sem configuração ou migração, o envio retorna erro e não simula sucesso.

- Microsoft 365 empresarial: `MAIL_PROVIDER=microsoft365`, `MAIL_FROM` com a caixa remetente, `MAIL_MS_TENANT_ID`, `MAIL_MS_CLIENT_ID` e `MAIL_MS_CLIENT_SECRET`. Requer registro de aplicativo no Entra ID com envio de aplicação autorizado pelo administrador. Restringir o aplicativo à caixa remetente usando os controles de acesso do Exchange Online (RBAC for Applications ou política de acesso suportada), evitando acesso a todas as caixas. As mensagens são solicitadas com cópia em Itens Enviados. Este fluxo de aplicação não atende contas pessoais Outlook.com/Hotmail.
- SMTP: `MAIL_PROVIDER=smtp`, `MAIL_FROM`, `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT` (465 com TLS ou 587 com STARTTLS obrigatório), `MAIL_SMTP_USER` e `MAIL_SMTP_PASSWORD`. Usar credencial específica de aplicativo/serviço autorizada pelo provedor, quando suportada. Não habilitar autenticação legada no Microsoft 365 para contornar políticas; nesse caso usar a integração Microsoft Graph. Gmail pode exigir senha de aplicativo e verificação em duas etapas, conforme política da conta.
- Piloto: definir `MAIL_TEST_RECIPIENT` para **um endereço de teste autorizado**. Outros destinatários são bloqueados, não redirecionados. Usar DROP e fechamento de teste em ambiente de homologação; não alterar e-mails de cadastros reais para testar. Validar recebimento e PDF antes de remover a restrição com autorização. Nenhum envio real foi realizado pelos testes automatizados.

Cada combinação de fechamento, parceiro e DROP tem uma reserva única persistente no banco. Cliques concorrentes, recarregamento da página e repetição do mesmo lote não reenviam mensagens aceitas. Erro de rede, envio interrompido ou falha ao finalizar o registro deixam o envio **INCERTO** ou **ENVIANDO**, bloqueando novas tentativas. O operador deve conferir a caixa remetente/provedor antes de qualquer intervenção autorizada na reserva; não remover reservas automaticamente. A interface interrompe o lote em resultados incertos. Reenvio deliberado de fechamentos reais não está disponível nesta versão.

O PDF do fechamento é gerado pela interface financeira autorizada e validado no servidor quanto a formato e limite de 1 MB; o servidor confere vínculo do DROP e período e não aceita destinatário arbitrário. O `GET /api/financial/send-closing` verifica configuração e schema, mas não autentica antecipadamente no provedor. A conexão real e a entrega precisam ser confirmadas no piloto. Contas pessoais Microsoft exigem um fluxo OAuth delegado próprio, ainda não implementado.

`npm test` cobre conectores simulados, permissões, destinatário cadastrado, reserva concorrente, resultado incerto e RLS. `npm run test:browser` verifica confirmação, envio do PDF sem download e estados de erro, sem chamadas externas. Para verificar tipos da API: `npx tsc --noEmit --skipLibCheck --module esnext --moduleResolution bundler --target es2022 --esModuleInterop api/financial/send-closing.ts`.
