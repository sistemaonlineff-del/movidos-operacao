# Fechamentos em Financas e pre-cadastro publico

Implementacao local de 08/11/2026. Sem publicacao automatica, SQL remoto ou importacao de valores reais pelo assistente.

## Interpretacao e limites

- Talita/Jorge e o valor da NF do fechamento devem alimentar o novo Financas, com vinculo ao periodo e CNPJ de origem.
- O destino empresa/pessoal e as categorias precisam ser escolhidos explicitamente na revisao: a mensagem alterna esses destinos e nao define uma correspondencia unica. Nao foi criado outro livro ou acesso publico ao Financas privado.
- Ganhos Movidos nao possuem um campo independente salvo. O resultado Talita/Jorge pode ser classificado no destino empresa e categoria desejada apos conferencia; nao ha uma segunda receita de lucro calculada/inventada automaticamente.
- O imposto requer base e aliquota explicitas. Nao ha presuncao de regime tributario, pagamento, competencia fiscal ou aliquota. O calculo e uma estimativa gerencial, nao apuracao fiscal certificada.
- A cliente ainda enviara a planilha/regra do financeiro Mais Envios. Nenhum dado desse modelo foi inventado.

## Financas > Fechamentos

O acesso continua restrito a Fabio e Talita ativos. Consultar a origem tambem requer a permissao existente `financeiro_view`; nao foram concedidas permissoes adicionais.

A aba le Views e periodos ativos, historico, itens, extravios e os dados cadastrais que o fechamento ja usa. Usa Talita/Jorge legado explicito quando existir, inclusive zero. Para fechamentos atuais sem resumo, reutiliza `buildDetails` e `buildTotals`, com a mesma formula da tela atual: total iMile menos total a receber dos Drops. Nao grava nem recalcula os registros da origem.

O valor da NF vem de `financial_periods.net_amount` quando preenchido, com fallback para `notes.summary.invoice` legado. Fonte ausente/inconsistente fica bloqueada. Resumos agregados de varios periodos/parceiros/CNPJs nao sao atribuidos automaticamente a uma unica empresa.

Selecionar as origens e informar destino, categoria/subcategoria, data e tipo de registro:

- Planejamento: registra previsao, sem entrada de caixa.
- Caixa: exige confirmacao de recebimento efetivo e conferencia contra importacao CSV. Emitir uma NF nao comprova recebimento.
- Se NF e Talita/Jorge forem selecionados no mesmo fechamento, confirmar que representam valores distintos. Isso evita dupla contagem involuntaria.
- Imposto: informar base manual ou a origem selecionada, aliquota de 0 a 100% com ate quatro casas decimais. Calculo inteiro com arredondamento comercial em centavos. Para gerar despesa, definir sua categoria e, em caixa, confirmar pagamento efetivo.

Cada origem tem vinculo estavel e snapshot. Reimportacao e alteracao/exclusao dos snapshots pela interface sao bloqueadas; fonte alterada gera aviso, sem sobrescrever dinheiro. Estorno acrescenta movimento inverso com data/motivo, preservando o original. O controle global de revisao e o historico privado continuam sendo usados. A protecao de snapshots e uma regra da aplicacao, nao uma nova politica imutavel de banco contra editores autorizados chamando a RPC diretamente.

Destino empresa/pessoal fica no vinculo e na descricao do movimento; os totais gerais do livro continuam agregados. Nao foi prometida separacao bancaria ou fiscal entre dois livros.

**Nenhum SQL adicional para esta aba.** Usa o schema privado de Financas ja informado como aplicado pelo usuario. Nenhum fechamento antigo e importado em massa.

## Cadastro por link

- Publico: `/cadastrar-drop`, sem login, consulta de cadastros existentes ou listagem publica.
- Interno: Cadastros > Pre-cadastros, em `/cadastros/pre-cadastros`.
- Na lista Drop off: copiar link, abrir formulario e compartilhar pelo WhatsApp. O dominio e o do app aberto, sem host de teste fixo.
- Formulario: nome do Drop, responsavel, telefone, endereco, CEP, cidade/UF, coordenadas, documentos/PIX opcionais e 1 a 3 fotos. Localizacao somente com clique/permissao; coordenadas manuais quando indisponivel. Fotos sao reduzidas/reencodadas pelo navegador, sem leitura de EXIF.
- Os dados enviados aparecem como pendentes. Revisor ativo administrador ou com `cadastros_create` e `cadastros_edit` confere/edita, visualiza fotos privadas, confere duplicados e aprova ou recusa.
- Aprovacao cria um cadastro `INTERESSADO`, sem datas de operacao, valor mensal, contrato ou lancamento financeiro. `is_active=true` significa nao excluido, nao uma operacao ATIVA. Na lista existente, trocar o filtro ATIVO por INTERESSADO/todos para encontra-lo.
- As fotos permanecem privadas e acessiveis pela revisao inclusive depois da aprovacao; nao sao copiadas automaticamente para `drop_photos` ou documentos/contratos do cadastro.

## SQL novo obrigatorio

Executar manualmente apos backup, antes do deploy desta entrega:

[20261108140000_public_drop_registration.sql](../supabase/migrations/20261108140000_public_drop_registration.sql)

Este e o unico SQL novo desta rodada. E diferente do `20261108120000_private_finances.sql` ja aplicado pelo usuario. Cria intake, quotas, RPCs e bucket privado isolado; nao substitui triggers, regras operacionais ou permissoes existentes. A migracao aborta se o schema/guard operacional necessario estiver ausente. Detalhes de teste e rollback conservador em [relatorio tecnico](../tests/drop-registration-report.md).

Servidor usa as mesmas variaveis existentes `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`, somente no backend. Nunca usar service key em variavel `VITE_*`. Vite sozinho nao executa a nova API serverless; o fluxo real requer deploy Vercel com a migracao. Nao ha chave nova.

## Protecoes e homologacao

Quotas: 20 tentativas por IP/dia e 500 globais/dia, incluindo repeticoes. IP e HMAC diario, nao texto armazenado. Fotos JPEG/PNG/WebP estaticas, ate 3, total decodificado 2 MiB; corpo ate 4,5 MB. Protocolo idempotente e upload sem sobrescrita; recebimento incompleto nao vira sucesso. URLs de fotos somente para revisores e por 60 segundos. Validacao de imagem nao e antivirus ou prova de identidade.

Sem CAPTCHA/WAF ou exclusao automatica de dados pessoais/fotos. Definir prazo de retencao e procedimento de descarte antes de distribuir amplamente o link. Consentimento operacional nao substitui revisao de privacidade/LGPD.

Testes usam exclusivamente dados sinteticos, PGlite e rede simulada. Homologar Supabase/Storage/Vercel hospedados, dispositivo real/Safari, envio simultaneo e conferencia dos valores reais apos deploy.

Comandos:

```powershell
npm run build
npm test
npm run test:financas
npm run test:financas-closing-browser
npm run test:financas-browser
npm run test:financas-app
npm run test:drop-registration
npm run test:improvements
```

`test:financas-app` e parte de `test:improvements` precisam de Vite em localhost:5173. Previa isolada sintetica, com API simulada: `node tests/drop-registration-harness.mjs --preview`.