import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { emptyState } from '../src/financas/domain.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = { revision: 0, writes: 0, calls: [], readPermission: true, active: true, privateAccess: true, failRead: false, failSave: false, data: emptyState(),
  views: [{ id: 'view-test', title: 'Fechamento sintetico', notes: { summary: { period: '1Q NOVEMBRO', invoice: 200, talitaJorge: 0 } } }],
  periods: [{ id: 'period-test', financial_view_id: 'view-test', label: '1Q NOVEMBRO', partner: 'iMile', reference_cnpj: 'MOVIDOS', net_amount: null, payment_date: null }] };
const mock = `import {validateState} from './src/financas/domain.ts';
export const control=window.__closingTest=JSON.parse(sessionStorage.getItem('synthetic-closing-book')||'null')||${JSON.stringify(fixture)};
export const persist=()=>sessionStorage.setItem('synthetic-closing-book',JSON.stringify(control));
export const supabase={auth:{getSession:async()=>({data:{session:control.privateAccess?{user:{id:'SYNTHETIC-FABIO'}}:null}})},from(table){let filters=[];const query={select(){return query;},eq(name,value){filters.push([name,value]);return query;},order(){return query;},async single(){control.calls.push({table,operation:'read'});if(!control.privateAccess)return {error:{message:'Sem acesso privado'}};return {data:table==='financas_members'?{role:'editor'}:{revision:control.revision,payload:structuredClone(control.data),updated_at:'2026-11-08'}};},async range(){control.calls.push({table,operation:'read'});if(!control.readPermission||!control.active||control.failRead)return {error:{message:'Consulta fonte negada'}};if(!['financial_views','financial_periods','financial_drop_items','financial_payment_history','loss_events','drops'].includes(table)||!filters.some(([name,value])=>name==='is_active'&&value===true))throw Error('Consulta inesperada');return {data:structuredClone(table==='financial_views'?control.views:table==='financial_periods'?control.periods:[])};},async limit(){return {data:[]};}};return query;},async rpc(name,args){control.calls.push({name,operation:'rpc',expected:args.expected_revision});if(name!=='financas_save_book')throw Error('RPC inesperado');if(!control.privateAccess||control.failSave)return {error:{message:'Falha de gravacao simulada'}};if(args.expected_revision!==control.revision)return {error:{message:'Conflito de revisao'}};validateState(args.new_payload);control.data=structuredClone(args.new_payload);control.revision++;control.writes++;persist();return {data:{revision:control.revision,updated_at:'2026-11-08'}};}};`;
const access = `import {useEffect,useState} from 'react';export function useAccess(){const [,update]=useState(0);useEffect(()=>{const listener=()=>update(value=>value+1);addEventListener('synthetic-access-change',listener);return()=>removeEventListener('synthetic-access-change',listener);},[]);return {profile:{is_active:window.__closingTest.active},loading:false,can:()=>window.__closingTest.readPermission};}`;

async function harness() {
  const output = await build({ stdin: { contents: "import React from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter,Routes,Route} from 'react-router-dom';import Financas from './src/financas/App.tsx';createRoot(document.getElementById('root')).render(<BrowserRouter><Routes><Route path='financas/*' element={<Financas/>}/></Routes></BrowserRouter>);", resolveDir: root, loader: 'tsx' }, bundle: true, write: false, outdir: 'memory', platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.woff': 'dataurl', '.woff2': 'dataurl' }, plugins: [{ name: 'synthetic-closing-only', setup(builder) {
    builder.onResolve({ filter: /\/lib\/supabase$/ }, () => ({ path: 'client', namespace: 'synthetic' }));
    builder.onResolve({ filter: /^\.\.\/access$/ }, () => ({ path: 'access', namespace: 'synthetic' }));
    builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, args => ({ contents: args.path === 'client' ? mock : access, loader: 'js', resolveDir: root }));
  } }] });
  const js = output.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = output.outputFiles.find(file => file.path.endsWith('.css')).text;
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style><link rel="stylesheet" href="/module.css"></head><body><div id="root"></div><script src="/module.js"></script></body></html>';
  const server = createServer((request, response) => { response.setHeader('Content-Type', request.url === '/module.js' ? 'application/javascript' : request.url === '/module.css' ? 'text/css' : 'text/html'); response.end(request.url === '/module.js' ? js : request.url === '/module.css' ? css : html); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv.includes('--serve')) {
  const { url } = await harness();
  console.log(`LOCAL SYNTHETIC CLOSING PREVIEW ${url}/financas/fechamentos`);
} else {
  const { server, url } = await harness();
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => { if (route.request().url().startsWith(url)) return route.continue(); external.push(route.request().url()); return route.abort(); });
  const snapshot = () => page.evaluate(() => structuredClone(window.__closingTest));
  const selection = () => page.getByRole('checkbox', { name: 'Selecionar NF 1Q NOVEMBRO MOVIDOS', exact: true });
  const editor = () => page.locator('.closing-choice').filter({ has: page.getByText('Data efetiva', { exact: true }) });
  const confirm = () => page.getByRole('button', { name: 'Confirmar vinculos', exact: true });
  const sourceReady = () => page.locator('.closing-table tbody tr').first().waitFor();
  async function mapping() {
    await editor().getByLabel('Destino', { exact: true }).selectOption('pessoal');
    await editor().getByLabel('Data efetiva', { exact: true }).fill('2026-11-08');
    await editor().getByLabel('Categoria destino', { exact: true }).fill('Receitas revisadas');
    await editor().getByLabel('Subcategoria destino').fill('NF Movidos');
  }
  try {
    await page.goto(`${url}/financas/fechamentos`); await sourceReady();
    assert.equal((await snapshot()).writes, 0);
    assert.equal(await page.locator('.closing-table tbody tr').count(), 2);
    assert.match(await page.locator('.closing-table tbody tr').first().innerText(), /0,00/);
    await selection().check();
    assert.equal(await editor().getByLabel('Destino', { exact: true }).inputValue(), '');
    assert.equal(await editor().getByLabel('Data efetiva', { exact: true }).inputValue(), '');
    assert.equal(await editor().getByLabel('Registro', { exact: true }).inputValue(), 'planning');
    await confirm().click(); await page.getByRole('alert').filter({ hasText: 'Escolha destino' }).waitFor();
    await mapping();
    await editor().getByLabel('Revisar calculo de imposto').check();
    assert.equal(await editor().getByLabel('Aliquota percentual').inputValue(), '');
    await confirm().click(); await page.getByRole('alert').filter({ hasText: 'Valor invalido' }).waitFor();
    assert.equal((await snapshot()).writes, 0);
    await editor().getByLabel('Base manual (R$)').fill('100,01');
    await editor().getByLabel('Aliquota percentual').fill('6');
    assert.match(await editor().locator('.closing-tax-total').innerText(), /6,00/);
    await editor().getByLabel('Registrar tambem despesa de imposto').check();
    await editor().getByLabel('Categoria do imposto', { exact: true }).fill('Imposto revisado');
    await editor().getByLabel('Subcategoria do imposto').fill('NF');
    await confirm().click(); await page.getByText('Vinculos confirmados no book privado.').waitFor();
    let current = await snapshot();
    assert.equal(current.data.plans.length, 2); assert.equal(current.data.transactions.length, 0); assert.equal(current.writes, 1);
    await page.reload(); await sourceReady();
    assert.match(await page.locator('.closing-table tbody tr').last().innerText(), /Planejado/);
    await selection().check();
    assert.equal(await editor().getByLabel('Registro', { exact: true }).inputValue(), 'cash');
    assert.equal(await editor().getByLabel('Categoria destino', { exact: true }).inputValue(), 'Receitas revisadas');
    assert.equal(await editor().getByLabel('Data efetiva', { exact: true }).inputValue(), '');
    await editor().getByLabel('Data efetiva', { exact: true }).fill('2026-11-10');
    await confirm().click(); await page.getByRole('alert').filter({ hasText: 'recebimento efetivo' }).waitFor();
    await editor().getByLabel('Recebimento confirmado', { exact: false }).check();
    await editor().getByLabel('Registrar tambem despesa de imposto').check();
    await editor().getByLabel('Categoria do imposto', { exact: true }).fill('Imposto revisado'); await editor().getByLabel('Subcategoria do imposto').fill('NF');
    await confirm().click(); await page.getByRole('alert').filter({ hasText: 'pagamento efetivo' }).waitFor();
    await editor().getByLabel('Imposto pago efetivamente nesta data.').check();
    await page.evaluate(() => { window.__closingTest.failSave = true; });
    await confirm().click(); await page.getByRole('alert').filter({ hasText: 'Gravacao nao confirmada' }).waitFor();
    assert.equal((await snapshot()).writes, 1);
    await page.evaluate(() => { window.__closingTest.failSave = false; window.__closingTest.revision++; });
    await confirm().click(); await page.getByRole('alert').filter({ hasText: 'Gravacao nao confirmada' }).waitFor();
    assert.equal((await snapshot()).writes, 1);
    await page.getByRole('button', { name: 'Atualizar base', exact: true }).click(); await sourceReady();
    await page.evaluate(() => { const button = [...document.querySelectorAll('button')].find(item => item.textContent.includes('Confirmar vinculos')); button.click(); button.click(); });
    await page.getByText('Vinculos confirmados no book privado.').waitFor();
    current = await snapshot();
    assert.equal(current.writes, 2); assert.equal(current.data.transactions.length, 2); assert.equal(current.data.transactions[0].amount, 20000); assert.equal(current.data.transactions[1].amount, -600);
    const original = JSON.stringify(current.data.transactions[0]);
    await page.reload(); await sourceReady(); assert.equal(await selection().isDisabled(), true);
    await page.evaluate(() => { window.__closingTest.views[0].notes.summary.invoice = 250; });
    await page.getByRole('button', { name: 'Atualizar fechamentos salvos' }).click(); await sourceReady();
    assert.match(await page.locator('.closing-table tbody tr').last().innerText(), /Fonte alterada/);
    assert.equal((await snapshot()).data.transactions[0].amount, 20000);
    await page.evaluate(() => { window.__closingTest.views = []; });
    await page.getByRole('button', { name: 'Atualizar fechamentos salvos' }).click();
    await page.getByText('Nenhuma origem salva disponivel.').waitFor();
    assert.ok(await page.getByText('Origem indisponivel; snapshot preservado', { exact: true }).count() > 0);
    await page.evaluate(data => { window.__closingTest.views = data.views; }, fixture);
    await page.getByRole('button', { name: 'Atualizar fechamentos salvos' }).click(); await sourceReady();
    await page.getByRole('link', { name: 'Fluxo de caixa', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Todos os meses', exact: true }).check();
    await page.getByRole('button', { name: /^Editar lancamento NF/ }).click();
    await page.getByRole('dialog').getByLabel('Valor com sinal (R$)').fill('999,00');
    await page.getByRole('dialog').getByRole('button', { name: 'Salvar', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Snapshot de fechamento protegido' }).waitFor();
    assert.equal(JSON.stringify((await snapshot()).data.transactions[0]), original);
    await page.getByRole('dialog').getByRole('button', { name: 'Cancelar', exact: true }).click();
    await page.getByRole('link', { name: 'Fechamentos', exact: true }).click(); await sourceReady();
    await page.getByLabel('Lancamento original').selectOption(current.data.transactions[0].id);
    await page.getByLabel('Data do estorno').fill('2026-11-11'); await page.getByLabel('Motivo do estorno').fill('Devolucao sintetica conferida');
    await page.getByLabel('Devolucao ou correcao efetiva conferida', { exact: false }).check();
    await page.getByRole('button', { name: 'Confirmar estorno', exact: true }).click();
    await page.getByText('Estorno confirmado; lancamento original preservado.').waitFor();
    current = await snapshot(); assert.equal(current.data.transactions.length, 3); assert.equal(current.data.transactions[2].amount, -20000); assert.equal(JSON.stringify(current.data.transactions[0]), original);
    await page.evaluate(() => { window.__closingTest.failRead = true; });
    await page.getByRole('button', { name: 'Atualizar fechamentos salvos' }).click();
    await page.getByRole('alert').filter({ hasText: 'Consulta fonte negada' }).waitFor();
    assert.equal(await page.locator('.closing-table tbody tr').count(), 0);
    await page.evaluate(() => { window.__closingTest.failRead = false; });
    await page.getByRole('button', { name: 'Atualizar fechamentos salvos' }).click(); await sourceReady();
    const artifacts = resolve(root, 'tmp/financas-closing-tests'); await mkdir(artifacts, { recursive: true });
    for (const width of [1440, 390, 360]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `overflow ${width}`);
      await page.getByRole('checkbox', { name: 'Selecionar Talita/Jorge 1Q NOVEMBRO MOVIDOS', exact: true }).check();
      await editor().getByLabel('Revisar calculo de imposto').check();
      assert.equal(await editor().getByLabel('Aliquota percentual').inputValue(), '');
      assert.ok(await editor().evaluate(element => element.getBoundingClientRect().right <= innerWidth + 1));
      await page.screenshot({ path: resolve(artifacts, `closing-${width}.png`), fullPage: true });
      await page.getByRole('checkbox', { name: 'Selecionar Talita/Jorge 1Q NOVEMBRO MOVIDOS', exact: true }).uncheck();
    }
    const reads = (await snapshot()).calls.length;
    await page.evaluate(() => { window.__closingTest.readPermission = false; dispatchEvent(new Event('synthetic-access-change')); });
    await page.getByText(/Consulta restrita/).waitFor();
    assert.equal(await page.locator('.closing-table').count(), 0); assert.equal((await snapshot()).calls.length, reads);
    await page.evaluate(() => { window.__closingTest.readPermission = true; window.__closingTest.active = false; dispatchEvent(new Event('synthetic-access-change')); });
    assert.equal(await page.locator('.closing-table').count(), 0);
    await page.evaluate(() => { window.__closingTest.privateAccess = false; });
    await page.getByRole('button', { name: 'Atualizar base', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Sessao indisponivel' }).waitFor();
    assert.equal(await page.locator('.page-footer').count(), 0);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    assert.ok((await snapshot()).calls.every(call => call.operation === 'read' || call.name === 'financas_save_book'));
    console.log('PASS: fechamento salvo, zero, revisao sem writes, mapping explicito, imposto manual, planejamento->caixa, falha/conflito/double-submit, reopen/dedupe, fonte alterada/removida, editor protegido, estorno, permissoes, desktop1440/mobile390/360. Apenas dados sinteticos; zero rede externa.');
  } catch (failure) {
    console.error(JSON.stringify({ errors, external, text: await page.locator('#root').innerText() })); throw failure;
  } finally { await browser.close(); await new Promise(done => server.close(done)); }
}