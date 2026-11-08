import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { emptyState } from '../src/financas/domain.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
async function isolatedStore() {
  const mock=`export const control={session:true,member:true,readError:false,rpcError:false,malformed:false,historyError:false,calls:[],payload:${JSON.stringify(emptyState())}};
  export const supabase={auth:{getSession:async()=>({data:{session:control.session?{user:{id:'SYNTHETIC-ONLY'}}:null}})},from(table){control.calls.push({table});let user;
    const query={select(){return query;},eq(key,value){if(key==='user_id')user=value;return query;},order(){return query;},async limit(){return control.historyError?{error:{message:'history failure'}}:{data:[{revision:0,changed_at:'2026-11-08',changed_by:'synthetic'}]};},async single(){if(table==='financas_members')return control.member&&user==='SYNTHETIC-ONLY'?{data:{role:'editor'}}:{error:{message:'denied'}};return control.readError?{error:{message:'read failure'}}:{data:{revision:4,payload:control.payload,updated_at:'2026-11-08'}};}};return query;},
    async rpc(name,args){control.calls.push({name,args});return control.rpcError?{error:{message:'write failure'}}:{data:{revision:control.malformed?99:args.expected_revision+1,updated_at:'2026-11-08'}};}};`;
  const output=await build({stdin:{contents:"export * from './src/financas/store.ts';export {control} from './src/lib/supabase.ts';",resolveDir:root,loader:'ts'},bundle:true,format:'esm',platform:'node',write:false,
    plugins:[{name:'fake-auth-only',setup(builder){builder.onResolve({filter:/\/lib\/supabase(?:\.ts)?$/},()=>({path:'shared',namespace:'fake'}));builder.onLoad({filter:/.*/,namespace:'fake'},()=>({contents:mock,loader:'js'}));}}]});
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}#${crypto.randomUUID()}`);
}
test('store exige mesma sessao e membership lida pelo RLS, sem fallback',async()=>{
  const store=await isolatedStore();
  await assert.rejects(store.saveState({revision:4},emptyState()),/Permissao/);
  store.control.session=false;await assert.rejects(store.loadState(),/Sessao/);assert.equal(store.canWrite,false);assert.equal(store.control.calls.length,0);
  store.control.session=true;store.control.member=false;await assert.rejects(store.loadState(),/sem acesso/);assert.equal(store.canWrite,false);
  store.control.member=true;store.control.readError=true;await assert.rejects(store.loadState(),/read failure/);assert.equal(store.canWrite,false);
  store.control.readError=false;const loaded=await store.loadState();assert.equal(loaded.revision,4);assert.equal(store.canWrite,true);
  assert.ok(store.control.calls.every(call=>['financas_members','financas_books'].includes(call.table)));
});
test('store rejeita revisao/payload invalidos, preserva falhas e exige confirmacao RPC',async()=>{
  const store=await isolatedStore();const previous=await store.loadState();
  await assert.rejects(store.saveState({...previous,revision:null},emptyState()),/Revisao/);
  await assert.rejects(store.saveState(previous,{}),/Estrutura/);
  assert.equal(store.control.calls.filter(call=>call.name).length,0);
  store.control.rpcError=true;await assert.rejects(store.saveState(previous,emptyState()),/write failure/);assert.equal(previous.revision,4);
  store.control.rpcError=false;store.control.malformed=true;await assert.rejects(store.saveState(previous,emptyState()),/Confirmacao/);
  store.control.malformed=false;const next=await store.saveState(previous,emptyState());assert.equal(next.revision,5);
  const rpc=store.control.calls.at(-1);assert.equal(rpc.name,'financas_save_book');assert.equal(rpc.args.target_workspace,store.workspaceId);assert.equal(rpc.args.expected_revision,4);
  assert.deepEqual(rpc.args.new_payload,emptyState());
});
test('consulta historico usa somente namespace privado e propaga erro',async()=>{
  const store=await isolatedStore();assert.equal((await store.loadHistory()).length,1);assert.equal(store.control.calls[0].table,'financas_history');
  store.control.historyError=true;await assert.rejects(store.loadHistory(),/history failure/);
});