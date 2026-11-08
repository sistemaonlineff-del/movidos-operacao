import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import postcss from 'postcss';

const root = fileURLToPath(new URL('../', import.meta.url));
const moduleRoot = resolve(root, 'src/financas');
const source = process.env.FINANCAS_SOURCE || fileURLToPath(new URL('../../../Movidos-Financeiro/src/', import.meta.url));
test('todos os seletores CSS sao privados, inclusive dialogs e media queries', () => {
  for (const name of ['styles.css','projection.css']) {
    const css = readFileSync(resolve(moduleRoot,name),'utf8');
    postcss.parse(css).walkRules(rule => {
      for (const selector of rule.selectors) assert.ok(selector.startsWith('.financas-module'),selector);
    });
    assert.doesNotMatch(css, /:root|#root/);
  }
  const app = readFileSync(resolve(moduleRoot,'App.tsx'),'utf8');
  assert.match(app,/createPortal/); assert.match(app,/financas-module financas-portal/);
  assert.doesNotMatch(app,/signIn|signOut|BrowserRouter|className="sidebar|className="topbar/);
  const store = readFileSync(resolve(moduleRoot,'store.ts'),'utf8');
  assert.match(store,/from '\.\.\/lib\/supabase'/);
  assert.doesNotMatch(store,/api\/local|createClient|VITE_|financial_history|financial_books/);
});
test('dominio, CSV, CNAB e componentes da fonte preservados', {skip:!existsSync(resolve(source,'App.tsx'))}, () => {
  const normalize = text => text.trim().replaceAll('\r\n','\n').replaceAll("from './domain.ts'", "from './domain'");
  for (const name of ['domain.ts','csv.ts','cnab.ts']) assert.equal(normalize(readFileSync(resolve(moduleRoot,name),'utf8')),normalize(readFileSync(resolve(source,name),'utf8')),name);
  const parse = file => ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const original = parse(resolve(source,'App.tsx')); const adapted = parse(resolve(moduleRoot,'App.tsx'));
  const functions = tree => new Map(tree.statements.filter(ts.isFunctionDeclaration).map(node=>[node.name.text,node]));
  const before = functions(original), after = functions(adapted); const printer = ts.createPrinter({removeComments:true});
  for (const name of ['Dashboard','Metric','Cash','Planning','Analysis','Projection','EditorModal','ImportModal','Categories','Payments','Audit']) {
    assert.equal(printer.printNode(ts.EmitHint.Unspecified,after.get(name),adapted),printer.printNode(ts.EmitHint.Unspecified,before.get(name),original).replaceAll("navigate('/caixa')","navigate('/financas/caixa')"),name);
  }
});
test('typecheck isolado do modulo sem alterar tsconfig ou dependencias', () => {
  const options = {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,
    strict:true,skipLibCheck:true,noEmit:true,jsx:ts.JsxEmit.ReactJSX,allowImportingTsExtensions:true,esModuleInterop:true,allowSyntheticDefaultImports:true};
  const host = ts.createCompilerHost(options);
  const external = process.env.FINANCAS_TEST_DEPENDENCIES;
  host.resolveModuleNames = (names,containingFile) => names.map(name => {
    const local = ts.resolveModuleName(name,containingFile,options,host).resolvedModule;
    if (local || !external) return local;
    return ts.resolveModuleName(name,resolve(dirname(external),'financas-typecheck.ts'),options,host).resolvedModule;
  });
  const files = readdirSync(moduleRoot).filter(name=>/\.tsx?$/.test(name)).map(name=>resolve(moduleRoot,name));
  const program = ts.createProgram([...files,resolve(root,'src/vite-env.d.ts')],options,host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length,0,ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:file=>file,getCurrentDirectory:()=>root,getNewLine:()=> '\n'}));
});