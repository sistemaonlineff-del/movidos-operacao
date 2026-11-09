import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { emptyState } from '../src/financas/domain.ts';

async function isolated() {
  const mock = `export const control={calls:[],failure:false,conflict:false,revision:0,views:[{id:'v',title:'Teste',notes:{summary:{talitaJorge:0,invoice:100}}}],periods:[{id:'p',label:'1Q',partner:'iMile',reference_cnpj:'MOVIDOS',financial_view_id:'v',net_amount:null}]};
  export const supabase={auth:{getSession:async()=>({data:{session:{user:{id:'synthetic'}}}})},from(table){const query={select(){return query;},eq(){return query;},order(){return query;},async range(){control.calls.push(table);return control.failure?{error:{message:'read rejected'}}:{data:table==='financial_views'?control.views:control.periods};},async single(){return {data:table==='financas_members'?{role:'editor'}:{revision:control.revision,payload:${JSON.stringify(emptyState())},updated_at:'2026-11-08'}};}};return query;},async rpc(name,args){control.calls.push({name,args});if(control.conflict||args.expected_revision!==control.revision)return {error:{message:'revision conflict'}};control.revision++;return {data:{revision:control.revision,updated_at:'2026-11-08'}};}};`;
  const root = fileURLToPath(new URL('../', import.meta.url));
  const output = await build({ stdin: { contents: "export * from './src/financas/closingRead.ts';export * from './src/financas/closing.ts';export * from './src/financas/store.ts';export {control} from './src/lib/supabase.ts';", loader: 'ts', resolveDir: root }, bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'closing-synthetic-client', setup(builder) {
    builder.onResolve({ filter: /\/lib\/supabase(?:\.ts)?$/ }, () => ({ path: 'client', namespace: 'mock' }));
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: mock, loader: 'js' }));
  } }] });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}#${crypto.randomUUID()}`);
}
test('saved closing reader rejects permission before queries and propagates real source failures', async () => {
  const api = await isolated();
  await assert.rejects(api.loadClosingSources(false), /Permissao/);
  assert.deepEqual(api.control.calls, []);
  const rows = await api.loadClosingSources(true);
  assert.equal(rows[0].cents, 0);
  assert.equal(rows[1].cents, 10000);
  assert.deepEqual(api.control.calls.sort(), ['drops', 'financial_drop_items', 'financial_payment_history', 'financial_periods', 'financial_views', 'loss_events']);
  api.control.failure = true;
  await assert.rejects(api.loadClosingSources(true), { message: 'read rejected' });
  assert.ok(api.control.calls.every(call => typeof call === 'string'));
});
test('fechamento atual sem resumo usa a formula oficial e preserva zero legado', async () => {
  const api = await isolated();
  api.control.views[0].notes = { operationPeriod: { start: '2026-11-01', end: '2026-11-15' } };
  api.control.periods[0].net_amount = 123.45;
  const rows = await api.loadClosingSources(true);
  assert.equal(rows[0].cents, 12345);
  assert.match(rows[0].field, /formula atual/);
  assert.equal(rows[0].issue, '');
  assert.equal(api.control.views[0].notes.summary, undefined);
  api.control.views[0].notes.summary = { talitaJorge: 0 };
  assert.equal((await api.loadClosingSources(true))[0].cents, 0);
});
test('closing confirmation uses existing private revision RPC, no source writes and no save on conflict', async () => {
  const api = await isolated();
  const previous = await api.loadState(), rows = await api.loadClosingSources(true), row = rows[1];
  const next = api.confirmClosingChoices(previous.data, rows, [{ key: row.key, fingerprint: row.fingerprint, destination: 'pessoal', date: '2026-11-08', category: 'Receita', subcategory: 'NF', detail: '', mode: 'cash', cashAcknowledged: true, overlapAcknowledged: false }]);
  api.control.conflict = true;
  await assert.rejects(api.saveState(previous, next), /revision conflict/);
  assert.equal(api.control.revision, 0);
  assert.deepEqual(previous.data.transactions, []);
  api.control.conflict = false;
  const confirmed = await api.saveState(previous, next);
  assert.equal(confirmed.revision, 1);
  assert.equal(api.control.calls.at(-1).name, 'financas_save_book');
  assert.equal(api.control.calls.at(-1).args.expected_revision, 0);
  assert.equal(api.control.calls.at(-1).args.new_payload.schemaVersion, 1);
  await assert.rejects(api.saveState(previous, next), /revision conflict/);
});