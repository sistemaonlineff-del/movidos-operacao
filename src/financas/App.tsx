import { useDeferredValue, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, ArrowLeftRight, BarChart3, CalendarDays, Check, ChevronLeft, ChevronRight, CircleAlert, ClipboardList, CreditCard, Database, Download, FileCheck2, FileUp, LayoutDashboard, Pencil, Plus, RefreshCw, Save, Search, Settings2, Tags, Trash2, TrendingUp, Wallet, X } from 'lucide-react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { amountInput, analysis, dateLabel, identityKey, isPlanned, money, monthLabel, monthsOf, parseDate, parseMoney, planAmount, projection, searchable, summary, transactionKey } from './domain';
import type { Classification, Envelope, FinancialState, Identity, Payment, Plan, Transaction } from './domain';
import { canWrite, loadState, saveState } from './store';
import { csvExport, mergeStatement, previewStatement } from './csv';
import type { ImportPreview } from './csv';
import { createCnab } from './cnab';
import { readBackup } from './backup';
import Closing from './ClosingReview';
import { assertClosingSnapshots } from './closing';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
import './styles.css';
import './projection.css';

const navigation = [
  ['', 'Visao geral', LayoutDashboard], ['caixa', 'Fluxo de caixa', ArrowLeftRight], ['planejamento', 'Planejamento', CalendarDays],
  ['analise', 'Planejado x realizado', BarChart3], ['projecao', 'Projecao de caixa', TrendingUp], ['categorias', 'Categorias', Tags], ['pagamentos', 'Pagamentos / CNAB', CreditCard],
  ['fechamentos', 'Fechamentos', ClipboardList],
  ['auditoria', 'Conferencia da origem', FileCheck2], ['configuracoes', 'Configuracoes', Settings2],
] as const;
const today = () => new Date().toLocaleDateString('sv-SE');
const message = (error: unknown) => error instanceof Error ? error.message : 'Nao foi possivel concluir a operacao.';
const download = (name: string, content: string, type = 'text/plain;charset=utf-8') => {
  const url = URL.createObjectURL(new Blob([content], { type })); const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const blankIdentity: Identity = { classification: '', category: '', subcategory: '', detail: '' };
type Editor = { kind: 'transaction'; item: Transaction } | { kind: 'plan'; item: Plan } | { kind: 'payment'; item: Payment };
type SaveData = (data: FinancialState) => Promise<boolean>;

function IconButton({ label, children, onClick, disabled = false }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button type="button" className="icon-button" aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>;
}
function Empty({ children = 'Nenhum registro neste periodo.' }: { children?: ReactNode }) { return <div className="empty"><ClipboardList size={30}/><p>{children}</p></div>; }
function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const reference = useRef<HTMLDialogElement>(null);
  useEffect(() => { reference.current?.showModal(); return () => reference.current?.close(); }, []);
  return createPortal(<div className="financas-module financas-portal"><dialog ref={reference} onCancel={event => { event.preventDefault(); close(); }} aria-label={title}><header className="dialog-header"><h2>{title}</h2><IconButton label="Fechar" onClick={close}><X size={20}/></IconButton></header>{children}</dialog></div>, document.body);
}
function Field({ label, name, value, type = 'text', required = false, ...rest }: { label: string; name: string; value?: string | number; type?: string; required?: boolean; min?: string | number; max?: string | number; maxLength?: number }) {
  return <label>{label}<input name={name} defaultValue={value} type={type} required={required} {...rest}/></label>;
}
function IdentityFields({ value, onChange, state, required = false }: { value: Identity; onChange: (value: Identity) => void; state: FinancialState; required?: boolean }) {
  const all = [...state.plans, ...state.transactions];
  const categories = [...new Set([...(value.classification === 'Receita' ? state.catalog.income : state.catalog.expense), ...all.filter(item => item.classification === value.classification).map(item => item.category), value.category])].filter(Boolean).sort();
  const subcategories = [...new Set([...(state.catalog.children[value.category] ?? []), ...all.filter(item => item.classification === value.classification && item.category === value.category).map(item => item.subcategory), value.subcategory])].filter(Boolean).sort();
  const details = [...new Set([...(state.catalog.children[value.subcategory] ?? []), ...all.filter(item => identityKey({ ...item, detail: '' }) === identityKey({ ...value, detail: '' })).map(item => item.detail)])].filter(Boolean).sort();
  return <>
    <label>Classificacao<select value={value.classification} required={required} onChange={event => onChange({ ...blankIdentity, classification: event.target.value as Classification })}><option value="">Pendente</option><option>Receita</option><option>Despesa</option></select></label>
    <label>Categoria<select value={value.category} onChange={event => onChange({ ...value, category: event.target.value, subcategory: '', detail: '' })}><option value="">Sem categoria</option>{categories.map(item => <option key={item}>{item}</option>)}</select></label>
    <label>Subcategoria<select value={value.subcategory} onChange={event => onChange({ ...value, subcategory: event.target.value, detail: '' })}><option value="">Sem subcategoria</option>{subcategories.map(item => <option key={item}>{item}</option>)}</select></label>
    <label>Descricao gerencial<input list="detail-options" value={value.detail} onChange={event => onChange({ ...value, detail: event.target.value })} maxLength={500}/><datalist id="detail-options">{details.map(item => <option key={item} value={item}/>)}</datalist></label>
  </>;
}

export default function FinancasModule() {
  const [envelope,setEnvelope] = useState<Envelope | null>(null); const [error,setError] = useState(''); const [loading,setLoading] = useState(true); const [busy,setBusy] = useState(false); const lock = useRef(false);
  const [month,setMonth] = useState('2026-10'); const [notice,setNotice] = useState(''); const [editor,setEditor] = useState<Editor | null>(null); const [importOpen,setImportOpen] = useState(false);
  const location = useLocation();
  const route = location.pathname.replace(/^\/financas\/?/, '').replace(/\/$/, '');
  async function reload() {
    if (lock.current) return;
    setLoading(true); setError('');
    try { const result = await loadState(); setEnvelope(result); const latest = result.data.transactions.map(item=>item.date.slice(0,7)).sort().at(-1); if (!envelope && latest) setMonth(latest); }
    catch (failure) { setEnvelope(null); setEditor(null); setImportOpen(false); setError(message(failure)); } finally { setLoading(false); }
  }
  useEffect(() => { void reload(); }, []);
  useEffect(() => { if (!notice) return; const timer=setTimeout(()=>setNotice(''),6000); return ()=>clearTimeout(timer); },[notice]);
  const save: SaveData = async data => {
    if (!envelope || lock.current || loading) return false;
    lock.current=true; setBusy(true); setError('');
    try { assertClosingSnapshots(envelope.data,data); const next = await saveState(envelope,data); setEnvelope(next); setNotice(`Alteracoes salvas. Revisao ${next.revision}.`); return true; }
    catch (failure) { setError(message(failure)); return false; } finally { lock.current=false; setBusy(false); }
  };
  if (!envelope) return <section className="financas-module"><div className="startup"><h1>Financas</h1>{loading ? <p>Carregando base financeira...</p> : <><p role="alert">{error}</p><button onClick={()=>void reload()}><RefreshCw size={16}/>Tentar novamente</button></>}</div></section>;
  const state = envelope.data;
  const availableMonths = [...new Set([...monthsOf(state),month])].sort();
  const title = navigation.find(([path]) => path === route)?.[1] ?? 'Financas';
  const newTransaction = () => setEditor({kind:'transaction',item:{...blankIdentity,id:crypto.randomUUID(),date:today(),description:'',amount:0,balance:null,sourceRow:null,source:'manual',order:0}});
  const newPlan = () => setEditor({kind:'plan',item:{...blankIdentity,classification:'Despesa',id:crypto.randomUUID(),pix:'',notes:'',dueDay:null,sourceRow:null,amounts:{[month]:null},actualMonths:[]}});
  const newPayment = () => setEditor({kind:'payment',item:{id:crypto.randomUUID(),name:'',responsible:'',amount:0,pix:'',holder:'',date:today(),document:''}});
  return <section className="financas-module">
    <nav className="financas-subnav" aria-label="Financas">{navigation.map(([path,label,Icon])=><NavLink key={path} to={path ? `/financas/${path}` : '/financas'} end={path===''}><Icon size={17}/><span>{label}</span></NavLink>)}</nav>
    <div className="financas-content"><section className="page-heading"><div><h1>{title}</h1><p className="muted">{state.source.name || 'Base financeira'}</p></div><div className="heading-actions"><IconButton label="Atualizar base" onClick={()=>void reload()} disabled={busy||loading}><RefreshCw size={17}/></IconButton>{['','caixa','planejamento','analise'].includes(route)&&<label className="period"><CalendarDays size={17}/><select aria-label="Competencia" value={month} onChange={event=>setMonth(event.target.value)}>{availableMonths.map(item=><option key={item} value={item}>{monthLabel(item)}</option>)}</select></label>}{canWrite&&route==='caixa'&&<button className="primary" onClick={newTransaction}><Plus size={17}/>Novo lancamento</button>}{canWrite&&route==='planejamento'&&<button className="primary" onClick={newPlan}><Plus size={17}/>Novo planejamento</button>}{canWrite&&route==='pagamentos'&&<button className="primary" onClick={newPayment}><Plus size={17}/>Novo pagamento</button>}</div></section>
    {error&&<div className="error banner" role="alert"><CircleAlert size={18}/><span>{error}</span><IconButton label="Fechar aviso" onClick={()=>setError('')}><X size={16}/></IconButton></div>}{notice&&<div className="success banner" role="status"><Check size={18}/>{notice}</div>}{busy&&<div className="saving" role="status">Salvando...</div>}
    {canWrite&&route===''&&<div className="toolbar"><button className="primary" disabled={busy||loading} onClick={()=>setImportOpen(true)}><FileUp size={16}/>Importar extrato</button></div>}
    <Routes>
      <Route index element={<Dashboard state={state} month={month}/>}/>
      <Route path="caixa" element={<Cash state={state} month={month} edit={item=>setEditor({kind:'transaction',item})} importFile={()=>setImportOpen(true)}/>}/>
      <Route path="planejamento" element={<Planning state={state} month={month} edit={item=>setEditor({kind:'plan',item})}/>}/>
      <Route path="analise" element={<Analysis state={state} month={month}/>}/>
      <Route path="projecao" element={<Projection state={state} save={save} busy={busy} report={setError}/>}/>
      <Route path="categorias" element={<Categories state={state} save={save} busy={busy}/>}/>
      <Route path="pagamentos" element={<Payments state={state} edit={item=>setEditor({kind:'payment',item})} save={save} busy={busy} report={setError}/>}/>
      <Route path="fechamentos" element={<Closing state={state} save={save} busy={busy}/>}/>
      <Route path="auditoria" element={<Audit state={state}/>}/>
      <Route path="configuracoes" element={<Settings state={state} save={save} revision={envelope.revision} busy={busy} report={setError}/>}/>
      <Route path="*" element={<Navigate to="/financas" replace/>}/>
    </Routes><footer className="page-footer"><span>Movidos Financas</span><span>{state.transactions.length.toLocaleString('pt-BR')} lancamentos / revisao {envelope.revision}{canWrite?'':' / somente leitura'}</span></footer></div>
    {editor&&<EditorModal key={editor.item.id} editor={editor} state={state} month={month} save={save} busy={busy} close={()=>{if(!busy)setEditor(null);}}/>}
    {importOpen&&<ImportModal state={state} revision={envelope.revision} save={save} busy={busy} close={()=>{if(!busy)setImportOpen(false);}}/>}
  </section>;
}

function Dashboard({ state, month }: { state: FinancialState; month: string }) {
  const metrics = summary(state,month); const navigate=useNavigate();
  const compare = analysis(state,month).filter(item=>item.actual||item.planned).slice(0,6).map(item=>({...item,short:item.name.length>17?item.name.slice(0,16)+'...':item.name,planned:item.planned/100,actual:item.actual/100}));
  const byDay=new Map<string,number>();
  for(const item of state.transactions.filter(item=>item.date.startsWith(month))) byDay.set(item.date,(byDay.get(item.date)??0)+item.amount);
  let running=0;
  const timeline=[...byDay].sort(([left],[right])=>left.localeCompare(right)).map(([date,amount])=>{running+=amount;return {date:date.slice(-2),value:running/100};});
  const recent=state.transactions.filter(item=>item.date.startsWith(month)).sort((left,right)=>right.date.localeCompare(left.date)||left.order-right.order).slice(0,5);
  const signIssues=state.transactions.filter(item=>item.date.startsWith(month)&&((item.classification==='Receita'&&item.amount<0)||(item.classification==='Despesa'&&item.amount>0))).length;
  return <><div className="kpi-grid">
    <Metric label="Receitas classificadas" value={money(metrics.income)} icon={<ArrowDownLeft/>} color="green" note={`${metrics.count} lancamentos no periodo`}/>
    <Metric label="Despesas classificadas" value={money(metrics.expense)} icon={<ArrowUpRight/>} color="red" note={`Orcamento ${money(metrics.plannedExpense)}`}/>
    <Metric label="Movimento liquido" value={money(metrics.net)} icon={<Wallet/>} color="teal" note="Soma dos valores com sinal do extrato"/>
    <Metric label="Desvio de despesas" value={money(metrics.plannedExpense-metrics.expense)} icon={<TrendingUp/>} color={metrics.expense>metrics.plannedExpense?'red':'green'} note="Planejado menos realizado"/>
  </div>{(metrics.unclassified>0||signIssues>0)&&<div className="attention"><CircleAlert size={18}/><span><strong>{metrics.unclassified} lancamentos com classificacao incompleta</strong>{signIssues>0&&` / ${signIssues} com sinal divergente da classificacao`}</span><button onClick={()=>navigate('/financas/caixa')}>Conferir <ChevronRight size={16}/></button></div>}
  <div className="chart-grid"><section className="chart-section"><div className="section-title"><div><h2>Planejado e realizado</h2><p>Principais categorias de despesa</p></div><BarChart3 size={19}/></div>{compare.length?<div className="chart"><ResponsiveContainer width="100%" height="100%"><BarChart layout="vertical" data={compare} margin={{top:5,right:12,left:0,bottom:0}}><CartesianGrid horizontal={false} stroke="#e8eded"/><XAxis type="number" tickCount={3} tickFormatter={value=>`${Math.round(Number(value)/1000)}k`} tick={{fontSize:10}} axisLine={false} tickLine={false}/><YAxis type="category" dataKey="short" tick={{fontSize:9}} width={112} interval={0} axisLine={false} tickLine={false}/><Tooltip formatter={value=>money(Number(value)*100)} labelFormatter={(_label,payload)=>payload?.[0]?.payload?.name??''}/><Legend iconType="square" iconSize={8}/><Bar name="Planejado" dataKey="planned" fill="#b7d9d4" radius={[0,3,3,0]} maxBarSize={12} isAnimationActive={false}/><Bar name="Realizado" dataKey="actual" fill="#008a81" radius={[0,3,3,0]} maxBarSize={12} isAnimationActive={false}/></BarChart></ResponsiveContainer></div>:<Empty/>}</section>
  <section className="chart-section"><div className="section-title"><div><h2>Movimento acumulado</h2><p>Variacao de caixa no mes, sem saldo inicial</p></div><TrendingUp size={19}/></div>{timeline.length?<div className="chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={timeline} margin={{top:12,right:12,left:0,bottom:0}}><CartesianGrid vertical={false} stroke="#e8eded"/><XAxis dataKey="date" tick={{fontSize:11}} minTickGap={18} axisLine={false} tickLine={false}/><YAxis tickFormatter={value=>`${Math.round(Number(value)/1000)}k`} tick={{fontSize:11}} width={45} axisLine={false} tickLine={false}/><Tooltip formatter={value=>money(Number(value)*100)} labelFormatter={label=>`Dia ${label}`}/><Area name="Movimento acumulado" type="monotone" dataKey="value" stroke="#d49b25" fill="#f7edcf" strokeWidth={2} isAnimationActive={false}/></AreaChart></ResponsiveContainer></div>:<Empty/>}</section></div>
  <section className="table-section"><div className="section-title"><div><h2>Ultimos lancamentos</h2><p>{monthLabel(month)}</p></div><button className="text-button" onClick={()=>navigate('/financas/caixa')}>Ver fluxo de caixa <ChevronRight size={16}/></button></div><div className="table-scroll"><table><thead><tr><th>Data</th><th>Descricao do extrato</th><th>Categoria</th><th>Planejamento</th><th className="number">Valor</th></tr></thead><tbody>{recent.map(item=><tr key={item.id}><td className="nowrap">{dateLabel(item.date)}</td><td className="description">{item.description}</td><td>{item.category||<span className="muted">Pendente</span>}</td><td><span className={`badge ${isPlanned(item,state.plans)?'green':'neutral'}`}>{isPlanned(item,state.plans)?'Cadastrado':'Sem vinculo'}</span></td><td className={`number ${item.amount<0?'negative':'positive'}`}>{money(item.amount)}</td></tr>)}</tbody></table></div>{!recent.length&&<Empty/>}</section></>;
}
function Metric({ label,value,icon,color,note }: { label:string;value:string;icon:ReactNode;color:string;note:string }) { return <article className="metric"><div><span>{label}</span><span className={`metric-icon ${color}`}>{icon}</span></div><strong>{value}</strong><small>{note}</small></article>; }

function Cash({state,month,edit,importFile}:{state:FinancialState;month:string;edit:(item:Transaction)=>void;importFile:()=>void}) {
  const [query,setQuery]=useState('');const search=useDeferredValue(query);const [classification,setClassification]=useState('');const [category,setCategory]=useState('');const [status,setStatus]=useState('');const [allMonths,setAllMonths]=useState(false);const [page,setPage]=useState(0);
  const occurrences=new Map<string,number>(); for(const item of state.transactions) occurrences.set(transactionKey(item),(occurrences.get(transactionKey(item))??0)+1);
  const filtered=state.transactions.filter(item=>(allMonths||item.date.startsWith(month))&&(!classification||item.classification===classification)&&(!category||item.category===category)&&(!search||searchable([item.description,item.category,item.subcategory,item.detail,money(item.amount)].join(' ')).includes(searchable(search)))&&(!status||(status==='pending'&&(!item.classification||!item.category||!item.subcategory))||(status==='unmatched'&&!isPlanned(item,state.plans))||(status==='duplicate'&&occurrences.get(transactionKey(item))!>1)||(status==='sign'&&((item.classification==='Receita'&&item.amount<0)||(item.classification==='Despesa'&&item.amount>0))))).sort((left,right)=>right.date.localeCompare(left.date)||left.order-right.order);
  const last=Math.max(0,Math.ceil(filtered.length/50)-1);const current=Math.min(page,last);const rows=filtered.slice(current*50,current*50+50);
  useEffect(()=>setPage(0),[month,search,classification,category,status,allMonths]);
  const total=filtered.reduce((sum,item)=>sum+item.amount,0);
  return <><div className="toolbar"><label className="search"><Search size={17}/><input aria-label="Buscar lancamentos" placeholder="Buscar descricao, categoria ou valor" value={query} onChange={event=>setQuery(event.target.value)}/></label><select aria-label="Filtrar classificacao" value={classification} onChange={event=>setClassification(event.target.value)}><option value="">Receitas e despesas</option><option>Receita</option><option>Despesa</option></select><select aria-label="Filtrar categoria" value={category} onChange={event=>setCategory(event.target.value)}><option value="">Todas as categorias</option>{[...new Set(state.transactions.map(item=>item.category))].filter(Boolean).sort().map(item=><option key={item}>{item}</option>)}</select><select aria-label="Conferencia" value={status} onChange={event=>setStatus(event.target.value)}><option value="">Todos os lancamentos</option><option value="pending">Classificacao incompleta</option><option value="unmatched">Sem vinculo no planejamento</option><option value="duplicate">Possiveis duplicatas</option><option value="sign">Sinal divergente</option></select><label className="check"><input type="checkbox" checked={allMonths} onChange={event=>setAllMonths(event.target.checked)}/>Todos os meses</label></div>
  <div className="list-summary"><span><strong>{filtered.length.toLocaleString('pt-BR')}</strong> lancamentos <span className="divider">/</span> Total filtrado <strong className={total<0?'negative':'positive'}>{money(total)}</strong></span><div>{canWrite&&<button onClick={importFile}><FileUp size={16}/>Importar extrato</button>}<IconButton label="Exportar lancamentos filtrados" disabled={!filtered.length} onClick={()=>download('fluxo-de-caixa.csv',csvExport(filtered.map(item=>({Data:dateLabel(item.date),Descricao:item.description,Valor:amountInput(item.amount),Saldo:item.balance===null?'':amountInput(item.balance),Classificacao:item.classification,Categoria:item.category,Subcategoria:item.subcategory,Detalhe:item.detail,Planejado:isPlanned(item,state.plans)?'Sim':'Nao'}))),'text/csv;charset=utf-8')}><Download size={17}/></IconButton></div></div>
  <div className="table-scroll"><table className="cash-table"><thead><tr><th>Data</th><th>Descricao do extrato</th><th>Classificacao / categoria</th><th>Subcategoria / detalhe</th><th>Vinculo cadastral</th><th className="number">Valor</th><th className="number">Saldo informado</th><th/></tr></thead><tbody>{rows.map(item=><tr key={item.id}><td className="nowrap">{dateLabel(item.date)}<small>Origem {item.sourceRow??'manual'}</small></td><td className="description">{item.description}{occurrences.get(transactionKey(item))!>1&&<small className="warning-text">Possivel duplicata</small>}</td><td><span className={`badge ${item.classification==='Receita'?'green':item.classification==='Despesa'?'red':'neutral'}`}>{item.classification||'Pendente'}</span><small>{item.category||'Sem categoria'}</small></td><td>{item.subcategory||'Pendente'}<small>{item.detail||'Sem descricao gerencial'}</small></td><td><span className={`badge ${isPlanned(item,state.plans)?'green':'neutral'}`}>{isPlanned(item,state.plans)?'Cadastrado':'Sem vinculo'}</span></td><td className={`number ${item.amount<0?'negative':'positive'}`}>{money(item.amount)}</td><td className="number muted">{item.balance===null?'-':money(item.balance)}</td><td>{canWrite&&<IconButton label={`Editar lancamento ${item.sourceRow??item.description}`} onClick={()=>edit(item)}><Pencil size={15}/></IconButton>}</td></tr>)}</tbody></table></div>{!rows.length&&<Empty/>}<div className="pagination"><span>{filtered.length?current*50+1:0}-{Math.min((current+1)*50,filtered.length)} de {filtered.length}</span><div><IconButton label="Pagina anterior" disabled={current===0} onClick={()=>setPage(current-1)}><ChevronLeft size={17}/></IconButton><span>{current+1} / {last+1}</span><IconButton label="Proxima pagina" disabled={current>=last} onClick={()=>setPage(current+1)}><ChevronRight size={17}/></IconButton></div></div></>;
}

function Planning({state,month,edit}:{state:FinancialState;month:string;edit:(item:Plan)=>void}) {
  const [query,setQuery]=useState('');const [classification,setClassification]=useState('');
  const rows=state.plans.filter(item=>(!classification||item.classification===classification)&&searchable(`${item.category} ${item.subcategory} ${item.detail} ${item.notes}`).includes(searchable(query)));
  const total=rows.reduce((sum,item)=>sum+(planAmount(item,month,state.transactions)??0),0);
  return <><div className="toolbar"><label className="search"><Search size={17}/><input aria-label="Buscar planejamento" placeholder="Buscar categoria, descricao ou anotacao" value={query} onChange={event=>setQuery(event.target.value)}/></label><select aria-label="Classificacao do planejamento" value={classification} onChange={event=>setClassification(event.target.value)}><option value="">Receitas e despesas</option><option>Receita</option><option>Despesa</option></select></div>
    <div className="list-summary"><span><strong>{rows.length}</strong> itens / soma dos valores informados <strong>{money(total)}</strong></span><span className="muted">{rows.filter(item=>planAmount(item,month,state.transactions)===null).length} sem valor no mes</span></div>
    <div className="table-scroll"><table><thead><tr><th>Classificacao</th><th>Categoria</th><th>Subcategoria</th><th>Descricao</th><th>Vencimento</th><th>Anotacoes</th><th className="number">{monthLabel(month)}</th><th/></tr></thead><tbody>{rows.map(item=>{
      const amount=planAmount(item,month,state.transactions);
      return <tr key={item.id}>
        <td><span className={`badge ${item.classification==='Receita'?'green':'red'}`}>{item.classification}</span></td>
        <td>{item.category}</td><td>{item.subcategory}</td><td>{item.detail||'-'}</td>
        <td>{item.dueDay?`Dia ${item.dueDay}`:item.dueText||'-'}</td><td className="description muted">{item.notes||'-'}</td>
        <td className="number">{amount===null?<span className="muted">Nao informado</span>:money(amount)}{item.actualMonths.includes(month)&&<small>Vinculado ao realizado</small>}</td>
        <td>{canWrite&&<IconButton label={`Editar planejamento ${item.sourceRow??item.detail}`} onClick={()=>edit(item)}><Pencil size={15}/></IconButton>}</td>
      </tr>;
    })}</tbody></table></div>{!rows.length&&<Empty/>}</>;
}

function Analysis({state,month}:{state:FinancialState;month:string}) {
  const [classification,setClassification]=useState<Classification>('Despesa');const [group,setGroup]=useState<'category'|'subcategory'|'detail'>('category');const [onlyOver,setOnlyOver]=useState(false);
  const rows=analysis(state,month,classification,group).filter(item=>!onlyOver||item.delta<0);
  return <><div className="toolbar"><div className="segmented" role="group" aria-label="Tipo de analise">{(['Despesa','Receita'] as const).map(item=><button key={item} aria-pressed={classification===item} onClick={()=>setClassification(item)}>{item==='Despesa'?'Despesas':'Receitas'}</button>)}</div><select aria-label="Agrupar analise" value={group} onChange={event=>setGroup(event.target.value as typeof group)}><option value="category">Por categoria</option><option value="subcategory">Por subcategoria</option><option value="detail">Por descricao</option></select><label className="check"><input type="checkbox" checked={onlyOver} onChange={event=>setOnlyOver(event.target.checked)}/>Realizado acima do planejado</label><IconButton label="Exportar analise" onClick={()=>download(`analise-${month}.csv`,csvExport(rows.map(item=>({Grupo:item.name,Planejado:amountInput(item.planned),Realizado:amountInput(item.actual),Diferenca:amountInput(item.delta),ItensSemValor:item.unknown}))),'text/csv;charset=utf-8')}><Download size={17}/></IconButton></div><div className="table-scroll"><table><thead><tr><th>{group==='category'?'Categoria':group==='subcategory'?'Subcategoria':'Descricao'}</th><th className="number">Planejado</th><th className="number">Realizado</th><th className="number">Planejado - realizado</th><th>Execucao</th><th>Situacao</th></tr></thead><tbody>{rows.map(item=><tr key={item.name}><td><strong>{item.name}</strong>{item.unknown>0&&<small>{item.unknown} itens sem valor no mes</small>}</td><td className="number">{money(item.planned)}</td><td className="number">{money(item.actual)}</td><td className={`number ${item.delta<0?'negative':'positive'}`}>{money(item.delta)}</td><td><div className="execution"><progress max={Math.max(1,item.ratio)} value={item.ratio}/><span>{(item.ratio*100).toFixed(1)}%</span></div></td><td><span className={`badge ${item.delta<0?(classification==='Despesa'?'red':'green'):'neutral'}`}>{item.delta<0?(classification==='Despesa'?'Acima do orcamento':'Acima da previsao'):item.unknown?'Valores pendentes':item.delta===0?'Igual ao planejado':'Abaixo do planejado'}</span></td></tr>)}</tbody></table></div>{!rows.length&&<Empty/>}</>;
}

function EditorModal({editor,state,month,save,busy,close}:{editor:Editor;state:FinancialState;month:string;save:SaveData;busy:boolean;close:()=>void}) {
  const [identity,setIdentity]=useState<Identity>(editor.kind==='payment'?blankIdentity:editor.item);const [error,setError]=useState('');
  const exists=editor.kind==='transaction'?state.transactions.some(item=>item.id===editor.item.id):editor.kind==='plan'?state.plans.some(item=>item.id===editor.item.id):state.payments.some(item=>item.id===editor.item.id);
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();setError('');const fields=new FormData(event.currentTarget);const get=(name:string)=>String(fields.get(name)??'').trim();
    try {
      let next:FinancialState;
      if(editor.kind==='transaction') {
        const item:Transaction={...editor.item,...identity,date:parseDate(get('date')),description:get('description'),amount:parseMoney(get('amount')),balance:get('balance')?parseMoney(get('balance')):null};
        if(!item.description)throw new Error('Descricao obrigatoria.');
        next={...state,transactions:exists?state.transactions.map(current=>current.id===item.id?item:current):[item,...state.transactions]};
      } else if(editor.kind==='plan') {
        const amount=get('amount')?parseMoney(get('amount')):null;
        if(amount!==null&&amount<0)throw new Error('Planejamento deve ser zero ou positivo.');
        const automatic=fields.get('automatic')==='on';
        if(automatic&&identity.classification!=='Receita')throw new Error('Valor automatico disponivel somente para receitas.');
        const item:Plan={...editor.item,...identity,pix:get('pix'),notes:get('notes'),dueDay:get('dueDay')?Number(get('dueDay')):null,dueText:get('dueText'),amounts:{...editor.item.amounts,[month]:amount},actualMonths:automatic?[...new Set([...editor.item.actualMonths,month])]:editor.item.actualMonths.filter(value=>value!==month)};
        if(!item.category||!item.subcategory)throw new Error('Informe categoria e subcategoria.');
        next={...state,plans:exists?state.plans.map(current=>current.id===item.id?item:current):[...state.plans,item]};
      } else {
        const item:Payment={...editor.item,name:get('name'),responsible:get('responsible'),amount:parseMoney(get('amount')),pix:get('pix'),holder:get('holder'),date:parseDate(get('date')),document:get('document')};
        if(!item.name||item.amount<=0)throw new Error('Nome e valor positivo sao obrigatorios.');
        next={...state,payments:exists?state.payments.map(current=>current.id===item.id?item:current):[...state.payments,item]};
      }
      if(await save(next))close();
      else setError('Nao foi possivel salvar. Os dados deste formulario foram mantidos. Feche para conferir o aviso e atualizar a base antes de tentar novamente.');
    }catch(failure){setError(message(failure));}
  }
  async function remove() {
    if(!window.confirm('Excluir este registro da base ativa? O historico de revisoes sera preservado.'))return;
    const key=editor.kind==='transaction'?'transactions':editor.kind==='plan'?'plans':'payments';
    const next={...state,[key]:state[key].filter(item=>item.id!==editor.item.id)};
    if(await save(next))close();
    else setError('Nao foi possivel excluir. Feche para conferir o aviso e atualizar a base.');
  }
  return <Modal title={`${exists?'Editar':'Novo'} ${editor.kind==='transaction'?'lancamento':editor.kind==='plan'?'planejamento':'pagamento'}`} close={close}><form onSubmit={submit}><fieldset disabled={busy} className="form-grid">
    {editor.kind==='transaction'&&<><Field label="Data" name="date" value={editor.item.date} type="date" required/><Field label="Valor com sinal (R$)" name="amount" value={amountInput(editor.item.amount)} required/><label className="full">Descricao do extrato<input name="description" defaultValue={editor.item.description} required maxLength={2000}/></label><Field label="Saldo informado (R$)" name="balance" value={editor.item.balance===null?'':amountInput(editor.item.balance)}/><div/><IdentityFields value={identity} onChange={setIdentity} state={state}/></>}
    {editor.kind==='plan'&&<><IdentityFields value={identity} onChange={setIdentity} state={state} required/><Field label={`Planejado em ${monthLabel(month)} (R$)`} name="amount" value={editor.item.amounts[month]==null?'':amountInput(editor.item.amounts[month]!)}/><Field label="Dia do vencimento" name="dueDay" type="number" min={1} max={31} value={editor.item.dueDay??''}/><Field label="Referencia original do vencimento" name="dueText" value={editor.item.dueText??''}/><Field label="Chave Pix" name="pix" value={editor.item.pix}/><label className="check full"><input type="checkbox" name="automatic" defaultChecked={editor.item.actualMonths.includes(month)}/>Vincular ao realizado do mes</label><label className="full">Anotacoes<textarea name="notes" defaultValue={editor.item.notes} rows={3}/></label></>}
    {editor.kind==='payment'&&<><Field label="Favorecido / DROP" name="name" value={editor.item.name} required/><Field label="Responsavel" name="responsible" value={editor.item.responsible}/><Field label="Valor (R$)" name="amount" value={amountInput(editor.item.amount)} required/><Field label="Data do pagamento" name="date" value={editor.item.date} type="date" required/><Field label="Chave Pix" name="pix" value={editor.item.pix} required/><Field label="Titular do Pix" name="holder" value={editor.item.holder}/><Field label="CPF/CNPJ" name="document" value={editor.item.document} required/></>}
  </fieldset>{error&&<p role="alert" className="error">{error}</p>}<div className="dialog-actions">{exists&&<button type="button" className="danger" disabled={busy} onClick={()=>void remove()}><Trash2 size={16}/>Excluir</button>}<span/><button type="button" onClick={close} disabled={busy}>Cancelar</button><button className="primary" disabled={busy}><Save size={16}/>Salvar</button></div></form></Modal>;
}

function ImportModal({state,revision,save,busy,close}:{state:FinancialState;revision:number;save:SaveData;busy:boolean;close:()=>void}) {
  const [preview,setPreview]=useState<ImportPreview|null>(null);const [error,setError]=useState('');const [sourceRevision,setSourceRevision]=useState(revision);const [filename,setFilename]=useState('');
  async function read(file?:File) {
    setPreview(null);setError('');if(!file)return;
    try {if(file.size>10*1024*1024)throw new Error('Arquivo excede 10 MB.');const bytes=await file.arrayBuffer();let text=new TextDecoder('utf-8').decode(bytes);if(text.includes('\uFFFD'))text=new TextDecoder('windows-1252').decode(bytes);const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(value=>value.toString(16).padStart(2,'0')).join('');setPreview(previewStatement(text,state,hash));setSourceRevision(revision);setFilename(file.name);}catch(failure){setError(message(failure));}
  }
  async function commit(){try{if(sourceRevision!==revision)throw new Error('A base mudou. Reabra a importacao.');if(preview){if(await save(mergeStatement(state,preview)))close();else setError('Importacao nao confirmada. Feche para conferir o aviso e atualizar a base antes de tentar novamente.');}}catch(failure){setError(message(failure));}}
  return <Modal title="Importar extrato CSV" close={close}><div className="dialog-body"><label className="file-input"><FileUp size={26}/><span>Selecionar extrato bancario</span><input aria-label="Arquivo CSV" type="file" accept=".csv,text/csv" onChange={event=>void read(event.target.files?.[0])} disabled={busy}/></label>{filename&&<p>{filename}</p>}{error&&<p role="alert" className="error">{error}</p>}{preview&&<><div className="import-summary"><span><strong>{preview.rows.length}</strong>novos</span><span><strong>{preview.duplicates}</strong>duplicados ignorados</span><span><strong>{preview.errors.length}</strong>erros</span></div>{preview.errors.length>0&&<div className="error">{preview.errors.slice(0,20).map(item=><p key={item}>{item}</p>)}</div>}<div className="table-scroll"><table><thead><tr><th>Data</th><th>Descricao</th><th className="number">Valor</th></tr></thead><tbody>{preview.rows.slice(0,8).map(item=><tr key={item.id}><td>{dateLabel(item.date)}</td><td className="description">{item.description}</td><td className="number">{money(item.amount)}</td></tr>)}</tbody></table></div><p>Total novo: <strong>{money(preview.total)}</strong></p></>}</div><div className="dialog-actions"><span/><button onClick={close} disabled={busy}>Cancelar</button><button className="primary" disabled={busy||!preview?.rows.length||!!preview.errors.length} onClick={()=>void commit()}><Check size={16}/>Confirmar importacao</button></div></Modal>;
}

function Categories({state,save,busy}:{state:FinancialState;save:SaveData;busy:boolean}) {
  const [classification,setClassification]=useState<'Receita'|'Despesa'>('Despesa');const [query,setQuery]=useState('');const [error,setError]=useState('');
  const categories=classification==='Receita'?state.catalog.income:state.catalog.expense;
  async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();setError('');const form=event.currentTarget;const fields=new FormData(form);const category=String(fields.get('category')??'').trim(),subcategory=String(fields.get('subcategory')??'').trim(),detail=String(fields.get('detail')??'').trim();if(!category){setError('Categoria obrigatoria.');return;}const catalog=structuredClone(state.catalog);const key=classification==='Receita'?'income':'expense';catalog[key]=[...new Set([...catalog[key],category])];if(subcategory)catalog.children[category]=[...new Set([...(catalog.children[category]??[]),subcategory])];if(detail&&subcategory)catalog.children[subcategory]=[...new Set([...(catalog.children[subcategory]??[]),detail])];if(await save({...state,catalog}))form.reset();}
  return <><div className="toolbar"><div className="segmented">{(['Despesa','Receita'] as const).map(item=><button key={item} aria-pressed={classification===item} onClick={()=>setClassification(item)}>{item==='Despesa'?'Despesas':'Receitas'}</button>)}</div><label className="search"><Search size={17}/><input aria-label="Buscar categorias" placeholder="Buscar categoria" value={query} onChange={event=>setQuery(event.target.value)}/></label></div>{canWrite&&<form className="catalog-form" onSubmit={submit}><Field label="Categoria" name="category" required maxLength={150}/><Field label="Subcategoria" name="subcategory" maxLength={150}/><Field label="Descricao" name="detail" maxLength={150}/><button className="primary" disabled={busy}><Plus size={17}/>Adicionar</button></form>}{error&&<p className="error" role="alert">{error}</p>}<div className="catalog-list">{categories.filter(item=>searchable(item).includes(searchable(query))).map(item=><section key={item}><h2>{item}</h2><div>{(state.catalog.children[item]??[]).map(child=><div className="catalog-child" key={child}><strong>{child}</strong><span>{(state.catalog.children[child]??[]).join(' / ')||'Descricao livre'}</span></div>)}{!(state.catalog.children[item]??[]).length&&<p className="muted">Sem subcategorias cadastradas.</p>}</div></section>)}</div></>;
}

function Payments({state,edit,save,busy,report}:{state:FinancialState;edit:(item:Payment)=>void;save:SaveData;busy:boolean;report:(text:string)=>void}) {
  const [selected,setSelected]=useState<string[]>([]);const [accepted,setAccepted]=useState(false);
  const rows=state.payments;const selectedRows=rows.filter(item=>selected.includes(item.id));
  async function generate(){try{if(!accepted)throw new Error('Confirme a finalidade de homologacao.');const content=createCnab(selectedRows,state.bank);const sequence=state.bank.sequence;if(await save({...state,bank:{...state.bank,sequence:sequence+1}}))download(`HOMOLOGACAO_CI240_${String(sequence).padStart(7,'0')}.REM`,content,'text/plain;charset=us-ascii');}catch(failure){report(message(failure));}}
  return <><div className="attention"><CircleAlert size={20}/><span><strong>CNAB em homologacao</strong> / Nenhum pagamento e enviado ou confirmado pelo sistema.</span></div><div className="list-summary"><span><strong>{selectedRows.length}</strong> selecionados / <strong>{money(selectedRows.reduce((sum,item)=>sum+item.amount,0))}</strong></span><span>Remessa {state.bank.sequence}</span></div><div className="table-scroll"><table><thead><tr><th><input type="checkbox" aria-label="Selecionar todos os pagamentos" checked={rows.length>0&&selectedRows.length===rows.length} onChange={event=>setSelected(event.target.checked?rows.map(item=>item.id):[])}/></th><th>Favorecido</th><th>Data</th><th>Chave Pix</th><th>Titular</th><th>CPF/CNPJ</th><th className="number">Valor</th><th/></tr></thead><tbody>{rows.map(item=><tr key={item.id}><td><input type="checkbox" aria-label={`Selecionar pagamento ${item.name}`} checked={selected.includes(item.id)} onChange={event=>setSelected(event.target.checked?[...selected,item.id]:selected.filter(id=>id!==item.id))}/></td><td><strong>{item.name}</strong><small>{item.responsible}</small></td><td className="nowrap">{dateLabel(item.date)}</td><td>{item.pix}</td><td>{item.holder||'-'}</td><td>{item.document}</td><td className="number">{money(item.amount)}</td><td>{canWrite&&<IconButton label={`Editar pagamento ${item.name}`} onClick={()=>edit(item)}><Pencil size={15}/></IconButton>}</td></tr>)}</tbody></table></div>{!rows.length&&<Empty/>}{canWrite&&<div className="payment-actions"><label className="check"><input type="checkbox" checked={accepted} onChange={event=>setAccepted(event.target.checked)}/>Arquivo destinado a homologacao bancaria, nao a pagamento em producao.</label><button className="primary" disabled={busy||!accepted||!selectedRows.length} onClick={()=>void generate()}><Download size={17}/>Gerar CNAB de homologacao</button></div>}</>;
}

function Audit({state}:{state:FinancialState}) {
  const [code,setCode]=useState('');const issues=state.issues.filter(item=>!code||item.code===code);
  const codes=[...new Set(state.issues.map(item=>item.code))];
  return <><div className="audit-summary"><div><span>Arquivo de origem</span><strong>{state.source.name||'Nenhum arquivo migrado'}</strong></div><div><span>Formulas inventariadas</span><strong>{state.source.formulas.toLocaleString('pt-BR')}</strong></div><div><span>Ocorrencias de origem</span><strong>{state.issues.length}</strong></div></div><p className="hash">SHA-256: {state.source.sha256||'-'}</p><div className="toolbar"><select aria-label="Tipo de ocorrencia" value={code} onChange={event=>setCode(event.target.value)}><option value="">Todas as ocorrencias</option>{codes.map(item=><option key={item}>{item}</option>)}</select><span className="muted">Registro da migracao; nao representa validacao bancaria.</span></div><div className="table-scroll"><table><thead><tr><th>Tipo</th><th>Aba</th><th>Origem</th><th>Conferencia</th></tr></thead><tbody>{issues.map((item,index)=><tr key={`${item.cell}-${index}`}><td><span className="badge amber">{item.code}</span></td><td className="nowrap">{item.sheet}</td><td>{item.cell}</td><td>{item.message}</td></tr>)}</tbody></table></div>{!issues.length&&<Empty>Nenhuma ocorrencia registrada.</Empty>}</>;
}

function Settings({state,save,revision,busy,report}:{state:FinancialState;save:SaveData;revision:number;busy:boolean;report:(text:string)=>void}) {
  async function saveBank(event:FormEvent<HTMLFormElement>){event.preventDefault();const fields=new FormData(event.currentTarget);const bank={...state.bank};for(const key of Object.keys(bank) as (keyof typeof bank)[]){if(key==='sequence')bank.sequence=Number(fields.get(key));else bank[key]=String(fields.get(key)??'').trim();}await save({...state,bank,transferNames:String(fields.get('transferNames')??'').split('\n').map(item=>item.trim()).filter(Boolean)});}
  async function restore(file?:File){if(!file)return;try{if(file.size>15*1024*1024)throw new Error('Base excede 15 MB.');const data=readBackup(JSON.parse(await file.text()));if(!window.confirm(`Substituir a base ativa por ${data.transactions.length} lancamentos e ${data.plans.length} planejamentos? O historico anterior sera preservado.`))return;await save(data);}catch(failure){report(message(failure));}}
  const labels:Record<string,string>={name:'Razao social',document:'CNPJ da empresa',branch:'Agencia',branchDigit:'Digito da agencia',account:'Conta',accountDigit:'Digito da conta',street:'Logradouro',number:'Numero',complement:'Complemento',city:'Cidade',state:'UF',postalCode:'CEP',sequence:'Proxima remessa'};
  return <><section className="settings-section"><div className="section-title"><div><h2>Armazenamento</h2><p>Supabase / autenticacao e permissoes ativas</p></div><Database size={20}/></div><div className="backup-actions"><button onClick={()=>download(`movidos-financeiro-revisao-${revision}.json`,JSON.stringify(state,null,2),'application/json')}><Download size={17}/>Exportar copia da base</button>{canWrite&&<label className="button"><FileUp size={17}/>Restaurar / migrar base<input type="file" accept=".json,application/json" onChange={event=>{void restore(event.target.files?.[0]);event.target.value='';}} disabled={busy}/></label>}</div></section><section className="settings-section"><h2>Empresa pagadora / Banco Inter</h2><form onSubmit={saveBank}><fieldset disabled={!canWrite||busy} className="form-grid settings-grid">{Object.entries(state.bank).map(([key,value])=><Field key={`${key}-${value}`} label={labels[key]} name={key} value={value} type={key==='sequence'?'number':'text'} min={key==='sequence'?1:undefined} max={key==='sequence'?999999:undefined}/>)}<label className="full">Nomes para transferencia entre contas<textarea name="transferNames" defaultValue={state.transferNames.join('\n')} rows={5}/></label></fieldset>{canWrite&&<button className="primary" disabled={busy}><Save size={17}/>Salvar configuracoes</button>}</form></section></>;
}

function Projection({state,save,busy,report}:{state:FinancialState;save:SaveData;busy:boolean;report:(text:string)=>void}) {
  const rows=projection(state);
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();const fields=new FormData(event.currentTarget);
    try {const opening=parseMoney(String(fields.get('opening')));const adjustments:FinancialState['projection']['adjustments']={};for(const row of rows)adjustments[row.month]={participation:parseMoney(String(fields.get(`${row.month}-participation`))),other:parseMoney(String(fields.get(`${row.month}-other`)))};await save({...state,projection:{opening,adjustments}});}catch(failure){report(message(failure));}
  }
  return <><section className="chart-section projection-chart"><div className="section-title"><div><h2>Saldo acumulado previsto</h2><p>Receitas - despesas + participacao + outros ajustes</p></div><TrendingUp size={19}/></div><div className="chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={rows.map(row=>({...row,label:monthLabel(row.month),value:row.balance/100}))} margin={{top:10,right:15,left:0,bottom:0}}><CartesianGrid vertical={false} stroke="#e8eded"/><XAxis dataKey="label" tick={{fontSize:10}} minTickGap={30}/><YAxis tickFormatter={value=>`${Math.round(Number(value)/1000)} mil`} tick={{fontSize:11}} width={55}/><Tooltip formatter={value=>money(Number(value)*100)}/><Area name="Saldo previsto" type="linear" dataKey="value" stroke="#008a81" fill="#dbefea" strokeWidth={2}/></AreaChart></ResponsiveContainer></div></section><div className="attention"><CircleAlert size={18}/><span>Projecao parcial quando ha valores nao informados. Ajustes negativos reduzem o saldo; positivos aumentam. Nao representa saldo bancario confirmado.</span></div><form onSubmit={submit}><fieldset disabled={!canWrite||busy} className="projection-fields"><div className="projection-opening"><Field label="Saldo inicial (R$)" name="opening" value={amountInput(state.projection.opening)} required/></div><div className="table-scroll"><table><thead><tr><th>Competencia</th><th className="number">Receitas</th><th className="number">Despesas</th><th className="number">Resultado</th><th>Participacao (+/-)</th><th>Outros ajustes (+/-)</th><th className="number">Saldo acumulado</th><th>Pendencias</th></tr></thead><tbody>{rows.map(row=><tr key={row.month}><td className="nowrap">{monthLabel(row.month)}</td><td className="number">{money(row.income)}</td><td className="number">{money(row.expense)}</td><td className={`number ${row.net<0?'negative':'positive'}`}>{money(row.net)}</td><td><input aria-label={`Participacao ${row.month}`} name={`${row.month}-participation`} defaultValue={amountInput(row.participation)} required/></td><td><input aria-label={`Outros ajustes ${row.month}`} name={`${row.month}-other`} defaultValue={amountInput(row.other)} required/></td><td className={`number ${row.balance<0?'negative':'positive'}`}><strong>{money(row.balance)}</strong></td><td><span className="badge amber">{row.unknown} sem valor</span></td></tr>)}</tbody></table></div></fieldset>{canWrite&&<button className="primary" disabled={busy}><Save size={16}/>Salvar ajustes da projecao</button>}</form></>;
}