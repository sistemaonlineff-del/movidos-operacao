# Financeiro Mais Envios

Entrega de 09/11/2026. Deploy, execucao do SQL remoto e disparos reais nao foram realizados pelo assistente.

## Fonte verificada

- Arquivo privado indicado pelo usuario: `000. Mais Envios.xlsm`, em Downloads. Original apenas lido; macros nao executadas. O arquivo, VBA completo e linhas privadas nao entram no repositorio ou frontend.
- SHA256: `2D162078BD6287C17C213A72F0CB999762E1C3EBDDD658099C0A1A43B37592CB`.
- Abas: Cadastro, Modelos, Fluxo de caixa, Detalhamento, Resumo Final.
- Modulos controladores: M_Inserir_Fechamento, M_ExportarPDF, M_Enviar_Email_Fechamento, M_Lista_Periodos.
- Validacao automatica: ResultadoAutomaticoCodigo, linhas VBA 753-834; extracao, 687-745; principal por data, 846-939; postagens, 543-599.
- Formulas: C7 conta Marketplace valido; E7 = quantidade x 0,50; F7 soma postagens validas; G7 = 15%; H7 = 85%; M7 = ABS(H7-E7); N7 define quem paga.

## Fluxo

1. Abrir Financeiro > Mais Envios > Pagamento total e Novo fechamento.
2. Informar periodo. Importar um ou varios CSVs originais, separados por ponto e virgula, UTF-8 ou Windows-1252. Nao selecionar o XLSM: ele e o modelo, nao o arquivo de importacao dos pacotes.
3. Marketplace reconhece Id na primeira coluna e Codigo de Rastreio na sexta; Postagem reconhece Etiqueta/Status. Cabecalho deve estar nas cinco primeiras linhas. Codigos, IDs e telefones permanecem texto, sem perder zeros.
4. Smart do Marketplace vem do Atendente. No CSV de postagem original nao ha Smart; informar Smart das postagens antes de importar ou preencher a Smart de cada linha em Pagamento detalhes. Nada e deduzido do remetente/destinatario.
5. Conferir pendencias, editar codigos e decidir Sim/Nao nos casos manuais. Filtros por tipo/Smart/validacao e paginacao de 50 linhas.
6. Conferir resumo e contatos, assunto e corpo. Contato vem do cadastro Mais Envios apenas quando o nome e inequivoco e o usuario tem acesso a cadastros; pode ser explicitamente selecionado ou informado manualmente. Sem cadastro/permissao de cadastros, o contato manual continua possivel com permissao financeira de gerencia.
7. Confirmar: grava snapshot imutavel por periodo. Nao envia e-mail nem registra baixa/pagamento recebido. Mesma identificacao recupera salvamento de resposta perdida sem duplicar. Para mudar o periodo, iniciar outro fechamento; nao mover linhas ja importadas para outro mes.
8. PDF individual ou PDFs (ZIP), Excel de tres abas, rascunho EML com PDF anexo ou envio direto por Smart. Conta apenas de visualizacao pode consultar/baixar relatorios, mas nao importar, confirmar ou preparar/disparar mensagens.

Dados nao confirmados ficam apenas na memoria da tela, sem localStorage de clientes; antes de sair/recarregar ha aviso nativo quando suportado pelo navegador. Nao fechar uma revisao ainda nao confirmada. O app nao faz importacao automatica dos registros existentes no XLSM.

## Regras reais de validade

- Extrai um unico codigo distinto no formato duas letras + nove numeros + BR, mesmo repetido em um texto ou interrompido por quebra de linha. Dois codigos diferentes continuam manuais; nao escolher o primeiro silenciosamente.
- Sim automatico: duas letras + nove numeros + BR, ou exatamente 10/11 digitos.
- Nao automatico: CEP de oito digitos, CEP com traco, BR + 13 digitos ou BR + 12 digitos + letra.
- Outros formatos, inclusive **cinco digitos**, exigem decisao manual. Diferenca importante em relacao a transcricao do audio: o VBA nao rejeita cinco digitos automaticamente.
- Marketplace preserva todas as linhas; uma ocorrencia por codigo e principal. Dentro da revisao vence a criacao mais antiga valida; em empate, a ultima linha. Sem data valida, a ultima linha. As demais ficam Duplicidade, sem remuneracao.
- Postagem ignora etiquetas repetidas, inclusive entre arquivos e periodos, sem distinguir maiusculas/minusculas. Dentro do mesmo CSV prevalece a ultima ocorrencia, como no percurso invertido da macro; uma etiqueta ja importada anteriormente nao e substituida pelo arquivo seguinte.
- Status Entregue = Sim; Etiqueta expirada = Nao. Outros status exigem decisao manual. Codigo vazio permanece pendente.
- E possivel corrigir o codigo sem apagar `originalCode` e as colunas originais do CSV. A nova versao e revalidada; decisao manual anterior nao e aplicada cegamente ao codigo corrigido.

## Calculos e correcoes explicitas

- Marketplace valido: quantidade x R$ 0,50.
- Postagens validas: soma dos valores; participacoes 15% Smart e 85% +Envios.
- Saldo = valor absoluto de (85% das postagens - remuneracao Marketplace). Positivo antes do absoluto: Smart paga para +Envios. Negativo: +Envios paga para Smart. Zero: Quitado.
- Calculo em centavos inteiros e numeradores BigInt; percentuais/saldo arredondados na exibicao, meio centavo para longe de zero. Assim como no Excel sem ROUND intermediario, percentuais arredondados individualmente podem diferir um centavo da soma exibida; saldo usa o valor nao arredondado, nao a subtracao de duas exibicoes ja arredondadas.
- **Correcao de F7:** o arquivo soma U mas filtra o periodo em A (Marketplace), em vez de L (Postagem). O app usa o periodo de cada linha/bloco; dados de meses diferentes nao se misturam pela posicao fisica das linhas.
- **Lista de Smarts:** considera Marketplace e Postagem. A formula original B7 nasce apenas de F/Marketplace e pode omitir uma Smart que tenha somente postagem.
- **Historico preservado:** diferente da macro que pode reclassificar outros periodos, um novo upload nao muda um fechamento confirmado. Codigo Marketplace ja presente em um snapshot fica Duplicidade no novo; uma criacao retroativa nao troca o principal historico. Corrigir um fechamento ja confirmado exige fluxo futuro de revisao/estorno, nao edicao/exclusao deste snapshot.
- Uma unica confirmacao por periodo (comparacao sem diferenciar caixa). Protecao transacional por lock tambem impede duas confirmacoes concorrentes de cobrarem o mesmo codigo/etiqueta. Se outro usuario confirmou antes, a tela exige atualizar/revisar; nao declara sucesso falso.
- CSV desconhecido, malformado ou valor monetario invalido aborta o lote inteiro antes de alterar a revisao. Diferenca conservadora da macro que apenas ignora arquivos nao reconhecidos.

O arquivo nao define comissao da Movidos, lucro proprio, impostos ou apropriar automaticamente as participacoes Smart/+Envios no livro Financas. A aba Fluxo de caixa nao foi importada. Nao ha lancamento automatico no caixa, CNAB Mais Envios ou grafico com valores presumidos. Vencimento e assinatura no corpo devem ser conferidos pelo operador; o dia 10/11 do modelo de outubro nao virou regra mensal automatica.

## Documentos e e-mail

PDF A4 retrato, Smart/periodo, resumo horizontal amarelo, postagens primeiro, Marketplace depois, cabecalhos repetidos e numeracao. Mantem linhas invalidas/duplicadas visiveis no detalhe; somente validas compoem os valores. Zeros de postagem no resumo ficam vazios quando nao ha postagem paga. Fonte nativa PDF e redistribuicao de larguras para caber em A4; nao promete igualdade pixel a pixel com o Excel.

Excel exporta Marketplace, Postagens e Resumo Final com valores calculados, nao formulas de link para o XLSM. IDs/telefones/rastreios sao texto; dinheiro e numero. O EML e um rascunho Outlook com `X-Unsent: 1`, destino/assunto/corpo preenchidos e PDF anexo; baixa nao significa envio. Alguns clientes podem tratar EML como mensagem em vez de rascunho: conferir no Outlook antes de usar.

Envio direto usa `/api/financial/mais-envios`, identidade real verificada pelo servidor, perfil ativo e `financeiro_manage` (ou administrador ativo), mesma configuracao SMTP/Microsoft 365 ja existente. Nao ha nova credencial ou remetente hardcoded. `MAIL_TEST_RECIPIENT` continua bloqueando destinos fora do piloto.

Servidor le o snapshot e gera o PDF; ignora destinatario ou PDF enviados arbitrariamente pelo cliente. Uma reserva unica por fechamento/Smart impede repeticao, inclusive concorrente e apos resposta perdida. Provedor aceitar nao significa entrega. Falha apos tentativa fica incerta, sem repeticao automatica; conferir a caixa remetente. Falha ao registrar aceite retorna incerto, nao sucesso. PDF acima de 2 MB exige rascunho/envio manual. Nao ha botao para forcar reenvio de tentativa incerta.

Envio manual do EML nao pode ser detectado pelo aplicativo. Nao usar envio direto depois de ja enviar manualmente; a confirmacao alerta para esse risco. Assunto/corpo/contatos sao preservados ao confirmar: alterar cadastro depois nao muda o destinatario antigo.

## SQL e acesso

Executar manualmente [20261109130000_mais_envios_closings.sql](../supabase/migrations/20261109130000_mais_envios_closings.sql) no banco atual **antes** do deploy. Requer perfis/permissoes ja existentes. Nao reaplicar schema inicial ou scripts antigos. Este SQL e independente do [20261109120000_label_reader_opt_in.sql](../supabase/migrations/20261109120000_label_reader_opt_in.sql) preparado para o leitor dos motoristas; ambos pertencem a rodada de 09/11.

Cria somente `mais_envios_closings`, `mais_envios_closing_mail`, helper e guard proprios. Leitura: perfil ativo com Financeiro ver/gerenciar ou administrador. Insercao de fechamento: perfil ativo com Financeiro gerenciar ou administrador, `created_by=auth.uid()`. UPDATE/DELETE de snapshots negados. Logs de envio sao somente leitura para usuarios financeiros; somente o servidor pode reservar/atualizar. Nao altera RLS, linhas ou valores das tabelas financeiras antigas, cadastros ou Financas privadas. Dados com status pendente/Smart ausente e codigos financeiros repetidos sao barrados no banco.

Limites: CSV ate 8 MB cada, 20.000 linhas por fechamento, payload ate 3 MB, campos CSV ate 2.000 caracteres, Smart ate 200, periodo ate 100, assunto ate 200 e corpo ate 30.000 caracteres. Um periodo confirmado nao e editavel neste modulo. Nao ha expurgo automatico ou migracao retroativa do XLSM.

## Verificacao

- `npm run test:mais-envios-closing`: regras, CSVs, duplicatas, periodos, centavos, PGlite/RLS/imutabilidade, API de e-mail sem chamadas reais.
- Referencia privada opcional: definir `MAIS_ENVIOS_WORKBOOK` com o caminho local do XLSM ao executar o comando acima. Foram conferidos 45 valores em cache do resumo, nenhuma diferenca superior a um centavo de arredondamento; nao executa/recalcula o Excel. O teste nao imprime clientes/codigos e nao copia dados para o repositorio.
- Vite em `127.0.0.1:5175`: `npm run test:mais-envios-closing-browser` (ou `MAIS_ENVIOS_BASE_URL`). App real, rede externa bloqueada, identidades e arquivos sinteticos. CSV/manual/edicao, resumo, Excel literal, PDF renderizado e pixels amarelos, ZIP/EML, recuperacao de resposta perdida, contato congelado, disparo unico, repeticao entre periodos, visualizacao desktop/celular e conta inativa.
- Capturas em `tmp/mais-envios-tests/screenshots`; somente dados ficticios. Compilacao e testes de regressao do repositorio tambem devem passar.
- Banco remoto, SMTP real, entrega de e-mail e Safari/dispositivo fisico nao foram homologados pelo assistente. Nenhum disparo ou dado de producao foi alterado.