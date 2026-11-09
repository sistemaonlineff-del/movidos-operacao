import { useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, Check, CircleAlert, RefreshCw, RotateCcw, Search } from 'lucide-react';
import { useAccess } from '../access';
import { canWrite } from './store';
import { amountInput, dateLabel, money, parseMoney, searchable } from './domain';
import type { FinancialState } from './domain';
import { calculateClosingTax, closingLink, closingStatus, confirmClosingChoices, reverseClosing } from './closing';
import type { ClosingChoice, ClosingSource } from './closing';
import { loadClosingSources } from './closingRead';
import './closing.css';

const labels = { review: 'Revisao', planned: 'Planejado', posted: 'No caixa', changed: 'Fonte alterada', reversed: 'Estornado' };
const failureMessage = (failure: unknown) => failure instanceof Error ? failure.message : typeof failure === 'object' && failure && 'message' in failure ? String(failure.message) : 'Nao foi possivel consultar o fechamento salvo.';
const newChoice = (source: ClosingSource): ClosingChoice => ({ key: source.key, fingerprint: source.fingerprint, destination: '', date: '', category: '', subcategory: '', detail: '', mode: 'planning', cashAcknowledged: false, overlapAcknowledged: false });

export default function Closing({ state, save, busy }: { state: FinancialState; save: (data: FinancialState) => Promise<boolean>; busy: boolean }) {
  const { profile, can, loading: accessLoading } = useAccess();
  const allowed = Boolean(!accessLoading && profile?.is_active && can('financeiro_view'));
  const permission = useRef(allowed); permission.current = allowed;
  const [rows, setRows] = useState<ClosingSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [query, setQuery] = useState(''); const [kind, setKind] = useState('');
  const [choices, setChoices] = useState<Record<string, ClosingChoice>>({});
  const [reversal, setReversal] = useState({ id: '', date: '', reason: '', acknowledged: false });
  const lock = useRef(false); const generation = useRef(0);
  useEffect(() => {
    const request = ++generation.current;
    setRows([]); setChoices({}); setError('');
    if (!allowed) { setLoading(false); return; }
    setLoading(true);
    void loadClosingSources(allowed).then(result => { if (generation.current === request && permission.current) setRows(result); })
      .catch(failure => { if (generation.current === request) setError(failureMessage(failure)); })
      .finally(() => { if (generation.current === request) setLoading(false); });
    return () => { generation.current++; };
  }, [allowed]);
  async function reload() {
    if (!permission.current || lock.current || busy) return;
    const request = ++generation.current;
    setLoading(true); setError(''); setNotice(''); setChoices({}); setRows([]);
    try { const result = await loadClosingSources(permission.current); if (generation.current === request && permission.current) setRows(result); }
    catch (failure) { if (generation.current === request) setError(failureMessage(failure)); }
    finally { if (generation.current === request) setLoading(false); }
  }
  const patch = (key: string, values: Partial<ClosingChoice>) => setChoices(current => ({ ...current, [key]: { ...current[key], ...values } }));
  const select = (row: ClosingSource, selected: boolean) => {
    if (!selected) { setChoices(current => { const next = { ...current }; delete next[row.key]; return next; }); return; }
    const plan = state.plans.find(item => { const link = closingLink(item.notes); return link && !link.taxEntry && link.slots.some(slot => row.slots.includes(slot)); });
    const link = plan ? closingLink(plan.notes) : null;
    const choice = newChoice(row);
    if (plan && link) {
      choice.mode = 'cash'; choice.destination = link.destination as ClosingChoice['destination']; choice.category = plan.category; choice.subcategory = plan.subcategory; choice.detail = plan.detail;
      if (link.tax) choice.tax = { rate: link.tax.rate, basis: link.tax.basis as 'source' | 'manual', base: amountInput(link.tax.base), category: '', subcategory: '', post: false, paidAcknowledged: false };
    }
    setChoices(current => ({ ...current, [row.key]: choice }));
  };
  async function confirm() {
    if (lock.current || busy || loading || !permission.current || !canWrite) return;
    lock.current = true; setLoading(true); setError(''); setNotice('');
    try {
      const fresh = await loadClosingSources(permission.current);
      if (!permission.current || !canWrite) throw new Error('Permissao alterada. Nenhum lancamento confirmado.');
      const next = confirmClosingChoices(state, fresh, Object.values(choices));
      setRows(fresh);
      if (await save(next)) { setChoices({}); setNotice('Vinculos confirmados no book privado.'); }
      else setError('Gravacao nao confirmada. Atualize a base privada e confira os vinculos antes de repetir.');
    } catch (failure) { setError(failureMessage(failure)); }
    finally { lock.current = false; setLoading(false); }
  }
  async function reverse() {
    if (lock.current || busy || !permission.current || !canWrite) return;
    lock.current = true; setLoading(true); setError(''); setNotice('');
    try {
      const next = reverseClosing(state, reversal.id, reversal.date, reversal.reason, reversal.acknowledged);
      if (await save(next)) { setReversal({ id: '', date: '', reason: '', acknowledged: false }); setNotice('Estorno confirmado; lancamento original preservado.'); }
      else setError('Estorno nao confirmado. Atualize e confira antes de repetir.');
    } catch (failure) { setError(failureMessage(failure)); }
    finally { lock.current = false; setLoading(false); }
  }
  if (!allowed) return <section className="closing-workspace"><p role="status">{accessLoading ? 'Carregando permissoes...' : 'Consulta restrita: sua conta precisa de permissao para ver o Financeiro de fechamentos.'}</p></section>;
  const filtered = rows.filter(row => (!kind || row.kind === kind) && searchable(`${row.title} ${row.period} ${row.partner} ${row.reference}`).includes(searchable(query)));
  const selected = rows.filter(row => choices[row.key]);
  const links = state.transactions.filter(item => closingLink(item.source));
  const plans = state.plans.filter(item => closingLink(item.notes));
  const categories = [...new Set([...state.catalog.income, ...state.catalog.expense, ...state.transactions.map(item => item.category), ...state.plans.map(item => item.category)])].filter(Boolean).sort();
  return <section className="closing-workspace">
    <div className="closing-notes"><p><strong>Fechamento salvo, nao extrato bancario.</strong> NF nao comprova recebimento. Talita/Jorge e NF podem representar o mesmo dinheiro; ganhos Movidos nao possuem valor salvo separado.</p><p>Planejamento nao movimenta caixa. Recebimento exige data efetiva e conferencia do extrato: importar CSV depois pode duplicar receita. Imposto depende de base e aliquota informadas, sem regra fiscal presumida.</p></div>
    <div className="toolbar"><label className="search"><Search size={17}/><input aria-label="Buscar fechamentos" value={query} onChange={event => setQuery(event.target.value)} placeholder="Periodo, parceiro, CNPJ"/></label><select aria-label="Origem do valor" value={kind} onChange={event => setKind(event.target.value)}><option value="">Todas as origens</option><option value="talitaJorge">Resultado Talita/Jorge salvo</option><option value="invoice">Valor NF salvo</option></select><button type="button" className="icon-button" title="Atualizar fechamentos salvos" aria-label="Atualizar fechamentos salvos" disabled={busy || loading} onClick={() => void reload()}><RefreshCw size={17}/></button></div>
    {loading && <p role="status">Conferindo fontes salvas...</p>}{error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="success banner"><Check size={16}/>{notice}</p>}
    <div className="list-summary"><span>{filtered.length} origens / {selected.length} selecionadas</span><span className="muted">Sem lancamento retroativo automatico</span></div>
    <div className="table-scroll"><table className="closing-table"><thead><tr><th>Selecionar</th><th>Fechamento / origem</th><th>Periodo / parceiro / CNPJ</th><th className="number">Valor salvo</th><th>Data na origem</th><th>Vinculo</th></tr></thead><tbody>{filtered.map(row => {
      const status = closingStatus(state, row);
      return <tr key={row.key}><td><input type="checkbox" aria-label={`Selecionar ${row.kind === 'invoice' ? 'NF' : 'Talita/Jorge'} ${row.period} ${row.reference}`} disabled={busy || loading || !canWrite || !!row.issue || !['review', 'planned'].includes(status)} checked={!!choices[row.key]} onChange={event => select(row, event.target.checked)}/></td><td className="description"><strong>{row.title}</strong><small>{row.kind === 'invoice' ? 'Valor NF' : 'Resultado Talita/Jorge'}</small><small>{row.table}.{row.field} / {row.recordId}</small></td><td>{row.period}<small>{row.partner} / {row.reference || 'CNPJ nao informado'}</small></td><td className="number">{row.cents === null ? 'Nao informado' : money(row.cents)}</td><td>{row.savedDate || 'Nao informada'}</td><td><span className={`badge ${row.issue || status === 'changed' ? 'amber' : status === 'review' ? 'neutral' : 'green'}`}>{row.issue ? 'Conferencia na origem' : labels[status]}</span>{row.issue && <small>{row.issue}</small>}</td></tr>;
    })}</tbody></table></div>{!loading && !filtered.length && <p className="empty">Nenhuma origem salva disponivel.</p>}
    <datalist id="closing-category-options">{categories.map(category => <option key={category} value={category}/>)}</datalist>
    {selected.map(row => {
      const choice = choices[row.key];
      let taxPreview: string = 'Base e aliquota pendentes';
      if (choice.tax) { try { const base = choice.tax.basis === 'source' ? row.cents! : parseMoney(choice.tax.base); taxPreview = money(calculateClosingTax(base, choice.tax.rate)); } catch { taxPreview = 'Base ou aliquota pendente/invalida'; } }
      return <fieldset className="closing-choice" key={row.key} disabled={busy || loading || !canWrite}><legend>{row.kind === 'invoice' ? 'NF' : 'Talita/Jorge'} / {row.period} / {row.reference} / {row.cents === null ? '' : money(row.cents)}</legend>
        <div className="closing-fields"><label>Destino<select aria-label="Destino" value={choice.destination} onChange={event => patch(row.key, { destination: event.target.value as ClosingChoice['destination'] })}><option value="">Escolha empresa ou pessoal</option><option value="empresa">Empresa</option><option value="pessoal">Pessoal</option></select></label><label>Registro<select aria-label="Registro" value={choice.mode} onChange={event => patch(row.key, { mode: event.target.value as ClosingChoice['mode'], cashAcknowledged: false })}><option value="planning">Planejamento</option><option value="cash">Recebimento efetivo / caixa</option></select></label><label>Data efetiva<input type="date" value={choice.date} onChange={event => patch(row.key, { date: event.target.value })}/></label><label>Categoria destino<input list="closing-category-options" maxLength={150} value={choice.category} onChange={event => patch(row.key, { category: event.target.value })}/></label><label>Subcategoria destino<input maxLength={150} value={choice.subcategory} onChange={event => patch(row.key, { subcategory: event.target.value })}/></label><label>Descricao gerencial<input maxLength={500} value={choice.detail} onChange={event => patch(row.key, { detail: event.target.value })}/></label></div>
        <label className="check"><input type="checkbox" checked={choice.overlapAcknowledged} onChange={event => patch(row.key, { overlapAcknowledged: event.target.checked })}/>NF e resultado selecionados sao valores distintos; nao ha dupla contagem.</label>
        {choice.mode === 'cash' && <label className="check"><input type="checkbox" checked={choice.cashAcknowledged} onChange={event => patch(row.key, { cashAcknowledged: event.target.checked })}/>Recebimento confirmado na data efetiva; conferi o extrato e o risco de duplicidade por CSV.</label>}
        <label className="check"><input type="checkbox" checked={!!choice.tax} onChange={event => patch(row.key, { tax: event.target.checked ? { rate: '', base: '', basis: 'manual', category: '', subcategory: '', post: false, paidAcknowledged: false } : undefined })}/>Revisar calculo de imposto</label>
        {choice.tax && <div className="closing-tax"><div className="closing-fields"><label>Base do imposto<select value={choice.tax.basis} onChange={event => patch(row.key, { tax: { ...choice.tax!, basis: event.target.value as 'source' | 'manual' } })}><option value="manual">Base manual</option><option value="source">Valor salvo desta origem</option></select></label>{choice.tax.basis === 'manual' && <label>Base manual (R$)<input inputMode="decimal" value={choice.tax.base} onChange={event => patch(row.key, { tax: { ...choice.tax!, base: event.target.value } })}/></label>}<label>Aliquota percentual<input inputMode="decimal" value={choice.tax.rate} onChange={event => patch(row.key, { tax: { ...choice.tax!, rate: event.target.value } })}/></label><div className="closing-tax-total"><span>Imposto estimado</span><strong>{taxPreview}</strong></div></div><label className="check"><input type="checkbox" checked={choice.tax.post} onChange={event => patch(row.key, { tax: { ...choice.tax!, post: event.target.checked } })}/>Registrar tambem despesa de imposto</label>{choice.tax.post && <div className="closing-fields"><label>Categoria do imposto<input list="closing-category-options" value={choice.tax.category} maxLength={150} onChange={event => patch(row.key, { tax: { ...choice.tax!, category: event.target.value } })}/></label><label>Subcategoria do imposto<input value={choice.tax.subcategory} maxLength={150} onChange={event => patch(row.key, { tax: { ...choice.tax!, subcategory: event.target.value } })}/></label>{choice.mode === 'cash' && <label className="check"><input type="checkbox" checked={choice.tax.paidAcknowledged} onChange={event => patch(row.key, { tax: { ...choice.tax!, paidAcknowledged: event.target.checked } })}/>Imposto pago efetivamente nesta data.</label>}</div>}</div>}
      </fieldset>;
    })}
    {selected.length > 0 && <div className="closing-actions"><CircleAlert size={17}/><span>Somente as origens selecionadas serao vinculadas.</span><button type="button" className="primary" disabled={busy || loading || !canWrite} onClick={() => void confirm()}><ArrowDownLeft size={17}/>Confirmar vinculos</button></div>}
    {(links.length > 0 || plans.length > 0) && <section className="closing-snapshots"><h2>Snapshots vinculados</h2><div className="table-scroll"><table><thead><tr><th>Origem preservada</th><th>Destino / categoria</th><th>Data / registro</th><th className="number">Valor</th><th>Conferencia</th></tr></thead><tbody>{[...plans.map(item => ({ item, link: closingLink(item.notes)!, mode: 'Planejado', date: closingLink(item.notes)!.date, amount: Object.values(item.amounts).reduce<number>((total, value) => total + (value ?? 0), 0) })), ...links.map(item => ({ item, link: closingLink(item.source)!, mode: closingLink(item.source)!.reversalOf ? 'Estorno' : 'Caixa', date: item.date, amount: item.amount }))].map(({ item, link, mode, date, amount }) => {
      const current = rows.find(row => row.key === link.key || row.slots.some(slot => link.slots.includes(slot)));
      const altered = current && current.fingerprint !== link.snapshot.fingerprint;
      return <tr key={`${mode}:${item.id}`}><td className="description">{link.taxEntry ? 'Imposto / ' : ''}{link.snapshot.kind === 'invoice' ? 'NF' : 'Talita/Jorge'} / {link.snapshot.title}<small>{link.snapshot.period} / {link.snapshot.reference} / {link.snapshot.recordId}</small>{link.tax && <small>Base {money(link.tax.base)} / aliquota {link.tax.rate}%</small>}</td><td>{link.destination}<small>{item.category} / {item.subcategory}</small></td><td>{dateLabel(date)}<small>{mode}</small></td><td className="number">{money(amount)}</td><td>{loading ? 'Conferindo' : !current ? 'Origem indisponivel; snapshot preservado' : altered ? 'Fonte alterada; dinheiro preservado' : 'Vinculo preservado'}</td></tr>;
    })}</tbody></table></div></section>}
    {canWrite && links.some(item => { const link = closingLink(item.source); return link && !link.reversalOf; }) && <fieldset className="closing-choice" disabled={busy || loading}><legend>Estorno efetivo</legend><div className="closing-fields"><label>Lancamento original<select value={reversal.id} onChange={event => setReversal({ ...reversal, id: event.target.value })}><option value="">Selecione um lancamento</option>{links.filter(item => !closingLink(item.source)?.reversalOf && !links.some(other => closingLink(other.source)?.reversalOf === item.id)).map(item => <option key={item.id} value={item.id}>{item.description} / {money(item.amount)}</option>)}</select></label><label>Data do estorno<input type="date" value={reversal.date} onChange={event => setReversal({ ...reversal, date: event.target.value })}/></label><label>Motivo do estorno<input maxLength={500} value={reversal.reason} onChange={event => setReversal({ ...reversal, reason: event.target.value })}/></label></div><label className="check"><input type="checkbox" checked={reversal.acknowledged} onChange={event => setReversal({ ...reversal, acknowledged: event.target.checked })}/>Devolucao ou correcao efetiva conferida; preservar o original e registrar movimento inverso.</label><button type="button" disabled={!reversal.id || !reversal.acknowledged} onClick={() => void reverse()}><RotateCcw size={16}/>Confirmar estorno</button></fieldset>}
  </section>;
}