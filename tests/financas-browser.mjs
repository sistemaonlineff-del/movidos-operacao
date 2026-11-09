import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { emptyState, validateState, projection } from '../src/financas/domain.ts';

const root = fileURLToPath(new URL('../',import.meta.url));
const requireRoot = createRequire(resolve(root,'package.json'));
const fixture = emptyState();
fixture.catalog={income:['Vendas'],expense:['Administrativa'],children:{Administrativa:['Aluguel']}};
fixture.bank={branch:'1',branchDigit:'9',account:'123',accountDigit:'0',name:'EMPRESA TESTE',document:'12345678000190',street:'RUA TESTE',number:'1',complement:'',city:'SAO PAULO',state:'SP',postalCode:'01001000',sequence:1};
fixture.plans=[{id:'plan',classification:'Despesa',category:'Administrativa',subcategory:'Aluguel',detail:'',pix:'',notes:'',dueDay:5,sourceRow:null,amounts:{'2026-10':10000,'2026-11':null},actualMonths:[]}];
fixture.transactions=[{id:'tx',classification:'Despesa',category:'Administrativa',subcategory:'Aluguel',detail:'',date:'2026-10-10',description:'MOVIMENTO FICTICIO',source:'synthetic',sourceRow:null,amount:-12000,balance:null,order:0}];
fixture.issues=[{code:'TEST',sheet:'Sintetica',cell:'A1',message:'Ocorrencia ficticia'}];
validateState(fixture);

const mock = `import {validateState} from './src/financas/domain.ts';
window.__financasTest={revision:0,data:${JSON.stringify(fixture)},updatedAt:'2026-11-08T12:00:00Z',access:true,fail:false,writes:0,history:[],calls:[]};
const state=window.__financasTest;
export const supabase={auth:{getSession:async()=>({data:{session:state.access?{user:{id:'synthetic-fabio'}}:null}})},
from(table){state.calls.push(table);if(!['financas_members','financas_books','financas_history'].includes(table))throw Error('Unexpected table '+table);
 const query={select(){return query;},eq(){return query;},order(){return query;},async limit(){return {data:state.access?state.history:[]};},async single(){if(!state.access)return {error:{message:'Sem acesso'}};return {data:table==='financas_members'?{role:'editor'}:{revision:state.revision,payload:structuredClone(state.data),updated_at:state.updatedAt}};}};return query;},
async rpc(name,args){state.calls.push(name);if(name!=='financas_save_book')throw Error('Unexpected RPC');if(!state.access)return {error:{message:'Sem permissao'}};if(state.fail)return {error:{message:'Falha simulada'}};
if(args.expected_revision!==state.revision)return {error:{message:'Outra sessao alterou a base'}};validateState(args.new_payload);state.history.push({revision:state.revision,payload:structuredClone(state.data)});state.data=structuredClone(args.new_payload);state.revision++;state.writes++;return {data:{revision:state.revision,updated_at:state.updatedAt}};}};`;

export async function startHarness() {
  const output = await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter,Routes,Route} from 'react-router-dom';import Financas from './src/financas/App.tsx';
createRoot(document.getElementById('root'),{onRecoverableError(error){console.error('FINANCAS RENDER CAUSE',error.cause?.stack || error.stack);throw error.cause || error;}}).render(<BrowserRouter><header id="outer-header"><h1>Shell externo</h1><button id="outer-button">Botao externo</button></header><Routes><Route path="financas/*" element={<Financas/>}/><Route path="*" element={<p id="outside">FORA DO MODULO</p>}/></Routes></BrowserRouter>);`,resolveDir:root,loader:'tsx'},
    bundle:true,write:false,outdir:'memory',format:'iife',platform:'browser',jsx:'automatic',
    nodePaths:process.env.FINANCAS_TEST_DEPENDENCIES?[process.env.FINANCAS_TEST_DEPENDENCIES]:[],
    loader:{'.woff2':'dataurl','.woff':'dataurl'},plugins:[{name:'fake-shared-client',setup(builder){
      builder.onResolve({filter:/^react(?:-dom)?(?:\/.*)?$/},args=>({path:requireRoot.resolve(args.path)}));
      builder.onResolve({filter:/\/lib\/supabase$/},()=>({path:'shared-supabase',namespace:'fake'}));
      builder.onLoad({filter:/.*/,namespace:'fake'},()=>({contents:mock,loader:'js',resolveDir:root}));
    }}]});
  const js=output.outputFiles.find(file=>file.path.endsWith('.js')).text;
  const css=output.outputFiles.find(file=>file.path.endsWith('.css')).text;
  const html='<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:rgb(240,240,240);color:rgb(10,20,30);font-family:serif}#root{max-width:1440px;margin:auto}#outer-header{padding:12px;background:rgb(230,230,230)}h1{font-size:18px;margin:7px}button{background:rgb(201,202,203);border-radius:0;padding:2px}dialog{color:red}</style><link rel="stylesheet" href="/module.css"></head><body><div id="root"></div><script src="/module.js"></script></body></html>';
  const server=createServer((request,response)=>{response.setHeader('Content-Type',request.url==='/module.js'?'application/javascript':request.url==='/module.css'?'text/css':'text/html');response.end(request.url==='/module.js'?js:request.url==='/module.css'?css:html);});
  await new Promise(resolveReady=>server.listen(0,'127.0.0.1',resolveReady));
  return {server,url:`http://127.0.0.1:${server.address().port}`};
}

if(process.argv.includes('--serve')) {
  const {url}=await startHarness();console.log(`FINANCAS SAFE HARNESS ${url}/financas`);
} else {
  const {server,url}=await startHarness();
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  const page=await context.newPage();const errors=[];const external=[];
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',route=>{if(route.request().url().startsWith(url))return route.continue();external.push(route.request().url());return route.abort();});
  const paths=['','caixa','planejamento','analise','projecao','categorias','pagamentos','fechamentos','auditoria','configuracoes'];
  const go=async path=>{await page.goto(`${url}/financas/${path}`);await page.locator('.page-footer').waitFor();};
  const dialog=()=>page.getByRole('dialog');
  const clickSave=async()=>{await dialog().getByRole('button',{name:'Salvar',exact:true}).click();await dialog().waitFor({state:'hidden'});};
  const snapshot=()=>page.evaluate(()=>structuredClone(window.__financasTest));
  const downloaded=async button=>{const pending=page.waitForEvent('download');await button.click();const download=await pending;const stream=await download.createReadStream();const chunks=[];for await(const chunk of stream)chunks.push(chunk);return {name:download.suggestedFilename(),content:Buffer.concat(chunks)};};
  try {
    await go('');
    assert.equal(await page.locator('.financas-subnav a').count(),10);
    assert.equal(await page.locator('#outer-button').evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(201, 202, 203)');
    assert.equal(await page.locator('#outer-header h1').evaluate(element=>getComputedStyle(element).fontSize),'18px');
    for(const label of ['Fluxo de caixa','Planejamento','Configuracoes','Visao geral']) {
      await page.getByRole('link',{name:label,exact:true}).click();
      await page.getByRole('heading',{name:label,level:1,exact:true}).waitFor();
      assert.ok(new URL(page.url()).pathname.startsWith('/financas'));
      assert.equal(await page.locator('#outside').count(),0);
      assert.equal(await page.getByRole('heading',{level:1}).last().textContent(),label);
    }
    await page.getByRole('button',{name:'Ver fluxo de caixa'}).click();assert.equal(new URL(page.url()).pathname,'/financas/caixa');
    await page.getByRole('button',{name:'Novo lancamento',exact:true}).click();
    assert.equal(await dialog().evaluate(element=>element.parentElement.className),'financas-module financas-portal');
    assert.equal(await dialog().evaluate(element=>getComputedStyle(element).color),'rgb(38, 60, 50)');
    await dialog().getByLabel('Data',{exact:true}).fill('2026-10-25');await dialog().getByLabel('Descricao do extrato').fill('TESTE-CRUD');await dialog().getByLabel('Valor com sinal (R$)').fill('-12,34');
    await page.evaluate(()=>window.__financasTest.fail=true);await dialog().getByRole('button',{name:'Salvar',exact:true}).click();
    await dialog().getByRole('alert').waitFor();assert.equal(await dialog().getByLabel('Descricao do extrato').inputValue(),'TESTE-CRUD');
    assert.equal((await snapshot()).writes,0);await page.evaluate(()=>window.__financasTest.fail=false);await clickSave();
    assert.equal((await snapshot()).data.transactions[0].amount,-1234);
    await page.getByLabel('Buscar lancamentos').fill('TESTE-CRUD');await page.getByRole('cell',{name:'TESTE-CRUD',exact:true}).waitFor();
    await page.getByRole('button',{name:'Editar lancamento TESTE-CRUD',exact:true}).click();await dialog().getByLabel('Valor com sinal (R$)').fill('0');await clickSave();
    assert.equal((await snapshot()).data.transactions.find(item=>item.description==='TESTE-CRUD').amount,0);
    await page.getByRole('button',{name:'Editar lancamento TESTE-CRUD',exact:true}).click();page.once('dialog',confirmation=>confirmation.accept());await dialog().getByRole('button',{name:'Excluir',exact:true}).click();await dialog().waitFor({state:'hidden'});
    assert.equal((await snapshot()).data.transactions.some(item=>item.description==='TESTE-CRUD'),false);
    await page.getByRole('button',{name:'Novo lancamento',exact:true}).click();await dialog().getByLabel('Descricao do extrato').fill('CONFLITO');
    await page.evaluate(()=>window.__financasTest.revision++);await dialog().getByRole('button',{name:'Salvar',exact:true}).click();await dialog().getByRole('alert').waitFor();
    assert.equal((await snapshot()).data.transactions.some(item=>item.description==='CONFLITO'),false);await dialog().getByRole('button',{name:'Cancelar',exact:true}).click();await page.getByRole('button',{name:'Atualizar base',exact:true}).click();await page.locator('.page-footer').waitFor();
    await page.getByRole('button',{name:'Importar extrato',exact:true}).click();
    const file={name:'sintetico.csv',mimeType:'text/csv',buffer:Buffer.from('Data;Descricao;Valor;Saldo\n26/10/2026;IMPORTADO;10,20;10,20\n26/10/2026;IMPORTADO;10,20;10,20')};
    await dialog().getByLabel('Arquivo CSV').setInputFiles(file);await dialog().getByRole('button',{name:'Confirmar importacao'}).click();await dialog().waitFor({state:'hidden'});
    assert.equal((await snapshot()).data.transactions.filter(item=>item.description==='IMPORTADO').length,1);
    await page.getByRole('button',{name:'Importar extrato',exact:true}).click();await dialog().getByLabel('Arquivo CSV').setInputFiles(file);await dialog().getByText('duplicados ignorados').waitFor();assert.equal(await dialog().getByRole('button',{name:'Confirmar importacao'}).isDisabled(),true);await dialog().getByRole('button',{name:'Cancelar',exact:true}).click();
    await page.getByLabel('Buscar lancamentos').fill('');
    const cashExport=await downloaded(page.getByRole('button',{name:'Exportar lancamentos filtrados'}));assert.match(cashExport.content.toString(),/IMPORTADO/);
    await page.getByRole('link',{name:'Planejamento',exact:true}).click();await page.getByRole('button',{name:'Novo planejamento',exact:true}).click();
    await dialog().getByRole('combobox',{name:'Categoria',exact:true}).selectOption('Administrativa');await dialog().getByRole('combobox',{name:'Subcategoria',exact:true}).selectOption('Aluguel');await dialog().getByRole('combobox',{name:'Descricao gerencial',exact:true}).fill('PLANO TESTE');await dialog().getByLabel(/Planejado em/).fill('0');await clickSave();
    assert.equal((await snapshot()).data.plans.find(item=>item.detail==='PLANO TESTE').amounts['2026-10'],0);
    await page.getByRole('link',{name:'Projecao de caixa',exact:true}).click();const before=await snapshot();
    const balances=projection(before.data).map(row=>row.balance);
    assert.equal(await page.locator('tbody tr').count(),balances.length);
    await page.getByLabel('Saldo inicial (R$)').fill('-1,00');await page.getByRole('button',{name:'Salvar ajustes da projecao'}).click();await page.getByRole('status').filter({hasText:`Revisao ${before.revision+1}.`}).waitFor();
    assert.equal((await snapshot()).data.projection.opening,-100);
    await page.getByRole('link',{name:'Planejado x realizado',exact:true}).click();await page.getByLabel('Agrupar analise').selectOption('subcategory');const analysisExport=await downloaded(page.getByRole('button',{name:'Exportar analise'}));assert.match(analysisExport.content.toString(),/Aluguel/);
    await page.getByRole('link',{name:'Pagamentos / CNAB',exact:true}).click();await page.getByRole('button',{name:'Novo pagamento',exact:true}).click();await dialog().getByLabel('Favorecido / DROP').fill('PAGAMENTO TESTE');await dialog().getByLabel('Valor (R$)',{exact:true}).fill('12,34');await dialog().getByLabel('Chave Pix').fill('test@example.com');await dialog().getByLabel('CPF/CNPJ').fill('12345678909');await clickSave();
    await page.getByLabel('Selecionar pagamento PAGAMENTO TESTE',{exact:true}).check();await page.getByLabel('Arquivo destinado a homologacao bancaria, nao a pagamento em producao.').check();
    const cnab=await downloaded(page.getByRole('button',{name:'Gerar CNAB de homologacao'}));assert.match(cnab.name,/^HOMOLOGACAO_/);assert.ok(cnab.content.toString().split('\r\n').slice(0,-1).every(line=>Buffer.byteLength(line)===240));assert.equal((await snapshot()).data.bank.sequence,2);
    await page.getByRole('link',{name:'Categorias',exact:true}).click();await page.getByLabel('Categoria',{exact:true}).fill('CATEGORIA TESTE');await page.getByRole('button',{name:'Adicionar',exact:true}).click();await page.getByRole('heading',{name:'CATEGORIA TESTE'}).waitFor();
    await page.getByRole('link',{name:'Conferencia da origem',exact:true}).click();await page.getByLabel('Tipo de ocorrencia').selectOption('TEST');assert.equal(await page.locator('tbody tr').count(),1);
    await page.getByRole('link',{name:'Configuracoes',exact:true}).click();const exported=await downloaded(page.getByRole('button',{name:'Exportar copia da base'}));assert.deepEqual(JSON.parse(exported.content.toString()),(await snapshot()).data);
    const restore=structuredClone(fixture);restore.projection.opening=-555;
    const priorRevision=(await snapshot()).revision;page.once('dialog',confirmation=>confirmation.accept());await page.locator('.backup-actions input[type=file]').setInputFiles({name:'export.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({revision:999,data:restore,updatedAt:'2026-11-08T12:00:00Z'}))});await page.getByRole('status').filter({hasText:`Revisao ${priorRevision+1}.`}).waitFor();assert.equal((await snapshot()).data.projection.opening,-555);assert.equal((await snapshot()).revision,priorRevision+1);
    for(const width of [1440,390,360]) {
      await page.setViewportSize({width,height:900});
      for(const path of paths) {
        await page.goto(`${url}/financas/${path}`);await page.locator('.page-footer').waitFor();
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`${path} overflow ${width}`);
        assert.equal(await page.locator('#outer-button').evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(201, 202, 203)');
        if(path==='') {await page.locator('.recharts-bar-rectangle path').first().waitFor();assert.ok(await page.locator('.recharts-bar-rectangle path').evaluateAll(elements=>elements.some(element=>element.getBoundingClientRect().width>10)));assert.ok((await page.screenshot()).length>1000);}
      }
      await page.getByRole('link',{name:'Fluxo de caixa',exact:true}).click();await page.getByRole('button',{name:'Novo lancamento',exact:true}).click();
      assert.ok(await dialog().evaluate(element=>element.getBoundingClientRect().width<=innerWidth));await page.keyboard.press('Escape');await dialog().waitFor({state:'hidden'});
    }
    await page.goto(`${url}/financas/unknown`);await page.locator('.page-footer').waitFor();assert.equal(new URL(page.url()).pathname,'/financas');
    await page.evaluate(()=>window.__financasTest.access=false);await page.getByRole('button',{name:'Atualizar base',exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(await page.locator('.page-footer').count(),0);assert.equal(await page.locator('input[type=password]').count(),0);
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    console.log('PASS: 10 rotas, CRUD/falha/conflito, CSV, planejamento, projecao, CNAB, categorias, auditoria, export/restore, portal/CSS, desktop/390/360; apenas dados sinteticos, zero rede externa.');
  } catch (failure) {
    console.error('Harness diagnostics:',JSON.stringify({errors,external,text:await page.locator('#root').innerText()}));
    throw failure;
  } finally {await browser.close();await new Promise(resolveClosed=>server.close(resolveClosed));}
}