// @ts-nocheck
import { ChangeEvent, useEffect, useState } from 'react'
import * as XLSX from 'xlsx'
import { buildDetails, buildTotals, notes } from './financialData'
import { readFinancialRows } from './financialStore'
import { supabase } from './lib/supabase'
import { normalizePartner } from './dropOptions'

type Row = Record<string, unknown>
type View = { id:string; title:string; source_file_name:string; source_rows:number; import_status:string; created_at:string; notes?:string|null }
const text=(value:unknown)=>String(value??'').trim()
const dropKey=(value:unknown)=>text(value).toLocaleUpperCase('pt-BR')
const number=(value:unknown)=>{
  if(typeof value==='number')return Number.isFinite(value)?value:0
  const raw=text(value).replace(/R\$\s?/g,'')
  const normalized=raw.includes(',')?raw.replace(/\./g,'').replace(',','.'):raw
  return Number(normalized)||0
}
const required=(row:Row, columns:string[])=>columns.every(column=>text(row[column]))
const hasColumns=(headers:unknown[],columns:string[])=>columns.every(column=>headers.includes(column))
const referenceCnpjs=['JOTA EXPRESS','MOVIDOS','BELLY'] as const
const referenceCnpj=(value:unknown)=>text(value).toLocaleUpperCase('pt-BR')
const validReferenceCnpj=(value:unknown)=>referenceCnpjs.includes(referenceCnpj(value) as typeof referenceCnpjs[number])
const excelDate=(value:unknown)=>{
  if(value instanceof Date&&!Number.isNaN(value.getTime()))return `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}T${String(value.getHours()).padStart(2,'0')}:${String(value.getMinutes()).padStart(2,'0')}:00`
  const raw=text(value)
  if(!raw)return null
  const serial=typeof value==='number'?value:Number(raw.replace(',','.'))
  if(Number.isFinite(serial)&&serial>25000&&serial<100000){
    const date=XLSX.SSF.parse_date_code(serial)
    if(date)return `${date.y}-${String(date.m).padStart(2,'0')}-${String(date.d).padStart(2,'0')}T${String(date.H).padStart(2,'0')}:${String(date.M).padStart(2,'0')}:${String(Math.floor(date.S)).padStart(2,'0')}`
  }
  const brazilian=raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  if(brazilian)return `${brazilian[3]}-${brazilian[2].padStart(2,'0')}-${brazilian[1].padStart(2,'0')}T${(brazilian[4]??'0').padStart(2,'0')}:${brazilian[5]??'00'}:${brazilian[6]??'00'}`
  const parsed=new Date(raw)
  return Number.isNaN(parsed.getTime())?null:parsed.toISOString()
}
const hasInvalidRows=(closing:Row[],losses:Row[])=>closing.some(row=>!required(row,['Periodo','Parceiro','Drop','CNPJReferencia'])||!validReferenceCnpj(row.CNPJReferencia)||!text(row.QuantidadePacote)||number(row.QuantidadePacote)<0)||losses.some(row=>!required(row,['Periodo','Parceiro','Drop','CNPJReferencia'])||!validReferenceCnpj(row.CNPJReferencia)||(text(row.DataRecebimento)&&!excelDate(row.DataRecebimento)))
const money=(value:unknown)=>number(value).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})
const reimbursementFromNotes=(notes:string|null|undefined)=>{try{const parsed=JSON.parse(notes??'{}');return number(parsed.reimbursement ?? parsed.summary?.reimbursement)}catch{return 0}}

export default function Financeiro(){
  const [views,setViews]=useState<View[]>([])
  const [selected,setSelected]=useState('')
  const [closing,setClosing]=useState<Row[]>([])
  const [losses,setLosses]=useState<Row[]>([])
  const [uploadPeriod,setUploadPeriod]=useState('')
  const [title,setTitle]=useState('')
  const [sourceFile,setSourceFile]=useState('')
  const [message,setMessage]=useState('')
  const [busy,setBusy]=useState(false)
  const [details,setDetails]=useState<any[]>([])
  const [viewLosses,setViewLosses]=useState<any[]>([])
  const [viewPeriods,setViewPeriods]=useState<any[]>([])
  const [viewTotals,setViewTotals]=useState<any[]>([])
  const [reimbursement,setReimbursement]=useState('')
  const [general,setGeneral]=useState({items:0,packages:0,losses:0,lossAmount:0})

  const loadGeneral=async()=>{
    if(!supabase)return
    try {
      const [items,history,lossRows,periods]=await Promise.all(['financial_drop_items','financial_payment_history','loss_events','financial_periods'].map(readFinancialRows))
      const details=buildDetails(history,items,lossRows,periods)
      setGeneral({items:details.length,packages:details.reduce((sum,row)=>sum+number(row.packages),0),losses:lossRows.length,lossAmount:lossRows.reduce((sum,row)=>sum+number(row.amount),0)})
    } catch(error) { setMessage(error?.message??'Falha ao atualizar a base geral.') }
  }

  const latestAgreedValues=async()=>{
    if(!supabase)return new Map<string,number>()
    let from=0, rows:Row[]=[]
    while(true){
      const {data,error}=await supabase.from('financial_drop_items').select('drop_name_snapshot,unit_value,created_at').eq('is_active',true).gt('unit_value',0).order('created_at',{ascending:false}).range(from,from+999)
      if(error)throw error
      rows=rows.concat((data??[]) as Row[])
      if((data??[]).length<1000)break
      from+=1000
    }
    const agreed=new Map<string,number>()
    rows.forEach(row=>{const key=dropKey(row.drop_name_snapshot);if(!agreed.has(key))agreed.set(key,number(row.unit_value))})
    return agreed
  }
  const refresh=async()=>{
    if(!supabase)return
    const {data,error}=await supabase.from('financial_views').select('*').eq('is_active',true).order('created_at',{ascending:false})
    if(error){setMessage('Execute a migração financeira no Supabase antes de usar este módulo.');return}
    setViews(data??[])
    await loadGeneral()
  }
  useEffect(()=>{void refresh()},[])
  useEffect(()=>{
    if(!selected||!supabase)return
    const load=async()=>{
      try {
        const [allPeriods,allItems,allLosses,allHistory,allDrops]=await Promise.all(['financial_periods','financial_drop_items','loss_events','financial_payment_history','drops'].map(readFinancialRows))
        const periods=allPeriods.filter(period=>period.financial_view_id===selected)
        const ids=new Set(periods.map(period=>period.id))
        const items=allItems.filter(item=>ids.has(item.financial_period_id)), loss=allLosses.filter(item=>ids.has(item.financial_period_id)), history=allHistory.filter(item=>ids.has(item.financial_period_id))
        const rows=buildDetails(history,items,loss,periods,allDrops)
        setDetails(rows.map(row=>({...row,closingRow:row,period:periods.find(period=>period.id===row.periodId),drop_name_snapshot:row.drop,quantity_packages:row.packages,standard_total:row.packages*.25,agreed_value:row.unit,gross_amount:row.subtotal,loss_amount:row.loss,receivable_amount:row.receivable})))
        setViewPeriods(periods);setViewLosses(loss);setViewTotals(buildTotals(rows,loss,periods,views.filter(view=>view.id===selected)))
      } catch(error) { setMessage(error?.message??'Não foi possível carregar o fechamento.');setDetails([]);setViewLosses([]);setViewTotals([]) }
    }
    void load()
  },[selected,views])
  useEffect(()=>{setReimbursement(String(reimbursementFromNotes(views.find(view=>view.id===selected)?.notes)))},[selected,views])

  const choose=async(event:ChangeEvent<HTMLInputElement>)=>{
    const file=event.target.files?.[0]
    if(!file)return
    const period=uploadPeriod.trim()
    if(!period){setMessage('Informe o período deste fechamento antes de anexar a planilha.');event.target.value='';return}
    setMessage('')
    try{
      const workbook=XLSX.read(await file.arrayBuffer(),{type:'array',cellDates:true})
      const closeSheet=workbook.Sheets['Fechamento'], lossSheet=workbook.Sheets['Extravios']
      if(!closeSheet||!lossSheet)throw new Error('Use o Modelo_Fechamento_Financeiro.xlsx, com as abas Fechamento e Extravios.')
      const close=XLSX.utils.sheet_to_json<Row>(closeSheet,{defval:''}), loss=XLSX.utils.sheet_to_json<Row>(lossSheet,{defval:''})
      const closeHeaders=(XLSX.utils.sheet_to_json(closeSheet,{header:1,defval:''})[0]??[]) as unknown[]
      const lossHeaders=(XLSX.utils.sheet_to_json(lossSheet,{header:1,defval:''})[0]??[]) as unknown[]
      if(!hasColumns(closeHeaders,['CNPJReferencia'])||!hasColumns(lossHeaders,['CNPJReferencia']))throw new Error('Baixe o modelo atualizado: a coluna CNPJReferencia Ã© obrigatÃ³ria nas duas abas.')
      if(!hasColumns(closeHeaders,['Periodo','Parceiro','Drop','QuantidadePacote'])||!hasColumns(lossHeaders,['Periodo','Parceiro','Drop','Waybill','CodigoEtiqueta','Saca','Status','Seller','DataRecebimento','ValorExtravio','Obs']))throw new Error('As colunas do modelo foram alteradas. Baixe o modelo atualizado e mantenha os cabeçalhos.')
      if(!close.length)throw new Error('A aba Fechamento não possui linhas para importar.')
      const closingForPeriod=close.map(row=>({...row,Periodo:period,Parceiro:normalizePartner(text(row.Parceiro)),CNPJReferencia:referenceCnpj(row.CNPJReferencia)}) as Row)
      const lossesForPeriod=loss.map(row=>({...row,Periodo:period,Parceiro:normalizePartner(text(row.Parceiro)),CNPJReferencia:referenceCnpj(row.CNPJReferencia)}) as Row)
      const invalid=closingForPeriod.filter(row=>!required(row,['Periodo','Parceiro','Drop','CNPJReferencia'])||!validReferenceCnpj(row.CNPJReferencia)||!text(row.QuantidadePacote)||number(row.QuantidadePacote)<0).length+lossesForPeriod.filter(row=>!required(row,['Periodo','Parceiro','Drop','CNPJReferencia'])||!validReferenceCnpj(row.CNPJReferencia)||(text(row.DataRecebimento)&&!excelDate(row.DataRecebimento))).length
      const references=new Map<string,string>()
      for(const row of [...closingForPeriod,...lossesForPeriod]){const key=`${text(row.Periodo)}|${text(row.Parceiro)}`,value=referenceCnpj(row.CNPJReferencia),existing=references.get(key);if(existing&&existing!==value)throw new Error(`O parceiro ${text(row.Parceiro)} possui mais de um CNPJ de referÃªncia no mesmo fechamento.`);references.set(key,value)}
      setClosing(closingForPeriod);setLosses(lossesForPeriod);setTitle(period);setSourceFile(file.name)
      if(invalid){setMessage(`${invalid} linha(s) precisam ser corrigidas antes da importação.`);return}
      await importView(closingForPeriod,lossesForPeriod,period,file.name)
    }catch(error){setClosing([]);setLosses([]);setMessage(error instanceof Error?error.message:'Não foi possível ler a planilha.')}
  }
  const chooseHistory=async(event:ChangeEvent<HTMLInputElement>)=>{
    const file=event.target.files?.[0]
    if(!file||!supabase)return
    if(!confirm('Esta ação apaga todas as Views financeiras, fechamentos e extravios atuais e substitui tudo pelos dados deste arquivo. Deseja continuar?')){event.target.value='';return}
    setBusy(true);setMessage('Lendo e substituindo a base histórica...')
    try{
      const workbook=XLSX.read(await file.arrayBuffer(),{type:'array'})
      let payload:any[]=[];let losses:any[]=[];let drops:any[]=[];let summaries:any[]=[]
      if(workbook.Sheets['Pgto Detalhes']&&workbook.Sheets['Extravios']&&workbook.Sheets['Cadastro']){
        const details=XLSX.utils.sheet_to_json<any[]>(workbook.Sheets['Pgto Detalhes'],{header:1,defval:''})
        const lossRows=XLSX.utils.sheet_to_json<any[]>(workbook.Sheets['Extravios'],{header:1,defval:''})
        const registration=XLSX.utils.sheet_to_json<any[]>(workbook.Sheets['Cadastro'],{header:1,defval:''})
        const totalRows=workbook.Sheets['Pgto Total']?XLSX.utils.sheet_to_json<any[]>(workbook.Sheets['Pgto Total'],{header:1,defval:''}):[]
        payload=details.slice(3).map(row=>({period:text(row[12]),drop:text(row[13]),partner:text(row[14]),packageType:text(row[15]),quantity:number(row[16]),agreed:number(row[17]),subtotal:number(row[18]),w2d:number(row[19]),d2d:number(row[20]),lossAmount:number(row[21]),reimbursement:number(row[22]),receivable:number(row[23]),paymentDate:excelDate(row[24]),pixKey:text(row[25])})).filter(row=>row.period&&row.drop)
        losses=lossRows.slice(3).map(row=>({period:text(row[0]),drop:text(row[1]),waybill:text(row[2]),labelCode:text(row[3]),bagCode:text(row[4]),status:text(row[5]),seller:text(row[6]),receivedAt:excelDate(row[7]),amount:number(row[8]),observation:text(row[9])})).filter(row=>row.period&&row.drop)
        // A coluna B do cadastro financeiro tem nomes de pessoas apesar do
        // cabeçalho "PARCEIRO". Ela nunca deve sobrescrever o parceiro do DROP.
        drops=registration.slice(1).map(row=>({name:text(row[0]),agreed:number(row[2]),pixKey:text(row[3]),email:text(row[4])})).filter(row=>row.name)
        summaries=totalRows.slice(2).map(row=>({period:text(row[0]),observation:text(row[1]),gross:number(row[2]),w2d:number(row[3]),d2d:number(row[4]),loss:number(row[5]),reimbursement:number(row[6]),invoice:number(row[7]),paidDrops:number(row[8]),deducted:number(row[9]),assumed:number(row[10]),talitaJorge:number(row[11]),paymentDate:excelDate(row[12])})).filter(row=>row.period)
      }else{
        const sheet=workbook.Sheets.Planilha1
        if(!sheet)throw new Error('Use o Controle Financeiro completo ou o Pasta1.xlsx com a aba Planilha1.')
        const rows=XLSX.utils.sheet_to_json<Row>(sheet,{defval:''})
        const headers=['PERÍODO','DROP','PARCEIRO','TOTAL PACOTE','VALOR ACORDADO']
        if(!rows.length||!headers.every(header=>Object.prototype.hasOwnProperty.call(rows[0],header)))throw new Error('As colunas do arquivo não correspondem ao histórico esperado.')
        payload=rows.map(row=>({period:text(row['PERÍODO']),drop:text(row.DROP),partner:text(row.PARCEIRO),quantity:number(row['TOTAL PACOTE']),agreed:number(row['VALOR ACORDADO'])})).filter(row=>row.period&&row.drop)
      }
      if(!payload.length)throw new Error('Nenhuma linha de Fechamento foi encontrada no arquivo.')
      const {data:{session}}=await supabase.auth.getSession()
      const response=await fetch('/api/financial/rebuild-history',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${session?.access_token??''}`},body:JSON.stringify({rows:payload,losses,drops,summaries,sourceFile:file.name})})
      const result=await response.json()
      if(!response.ok)throw new Error(result.error??'Não foi possível substituir a base histórica.')
      setSelected('')
      await refresh()
      setSelected(result.lastViewId)
      setMessage(`Base substituída: ${result.views} Views, ${result.rows} linhas de Fechamento e ${result.losses??0} extravios importados.`)
    }catch(error){setMessage(error instanceof Error?error.message:'Não foi possível importar o histórico.')}finally{setBusy(false);event.target.value=''}
  }
  const importView=async(sourceClosing=closing,sourceLosses=losses,sourceTitle=title,sourceFileName=sourceFile)=>{
    if(!supabase||!sourceClosing.length||hasInvalidRows(sourceClosing,sourceLosses))return
    setBusy(true);setMessage('Importando View...')
    try{
      const {data:view,error:viewError}=await supabase.from('financial_views').insert({title:sourceTitle,source_file_name:sourceFileName||`${sourceTitle}.xlsx`,source_rows:sourceClosing.length+sourceLosses.length,import_status:'rascunho'}).select().single()
      if(viewError)throw viewError
      const groups=[...new Map([...sourceClosing,...sourceLosses].map(row=>[`${text(row.Periodo)}|${text(row.Parceiro)}`,{label:text(row.Periodo),partner:text(row.Parceiro),reference_cnpj:referenceCnpj(row.CNPJReferencia)}])).values()]
      const {data:periods,error:periodError}=await supabase.from('financial_periods').insert(groups.map(group=>({...group,financial_view_id:view.id,status:'aberto'}))).select()
      if(periodError)throw periodError
      const periodIndex=new Map((periods??[]).map(period=>[`${period.label}|${period.partner}`,period.id]))
      const agreedByDrop=await latestAgreedValues()
      const chunks=<T,>(rows:T[])=>Array.from({length:Math.ceil(rows.length/400)},(_,index)=>rows.slice(index*400,index*400+400))
      for(const part of chunks(sourceClosing)){const {error}=await supabase.from('financial_drop_items').insert(part.map(row=>({financial_period_id:periodIndex.get(`${text(row.Periodo)}|${text(row.Parceiro)}`),drop_name_snapshot:text(row.Drop),quantity_packages:number(row.QuantidadePacote),unit_value:agreedByDrop.get(dropKey(row.Drop))??0,reimbursement:0})));if(error)throw error}
      for(const part of chunks(sourceLosses)){const {error}=await supabase.from('loss_events').insert(part.map(row=>({financial_period_id:periodIndex.get(`${text(row.Periodo)}|${text(row.Parceiro)}`),partner:text(row.Parceiro),period_label:text(row.Periodo),drop_name_snapshot:text(row.Drop),waybill:text(row.Waybill),label_code:text(row.CodigoEtiqueta),bag_code:text(row.Saca),status:text(row.Status),seller:text(row.Seller),received_at:excelDate(row.DataRecebimento),amount:number(row.ValorExtravio),observation:text(row.Obs)})));if(error)throw error}
      await supabase.from('financial_views').update({import_status:'importado'}).eq('id',view.id)
      setClosing([]);setLosses([]);setSourceFile('');setUploadPeriod('');setSelected(view.id)
      setMessage(`View de ${sourceTitle} importada com sucesso e consolidado geral atualizado.`)
      await refresh()
    }catch(error){setMessage(error instanceof Error?error.message:'Erro ao importar.')}finally{setBusy(false)}
  }
  const editLoss=async(loss:any)=>{
    if(!supabase)return
    const amount=prompt('Valor do extravio (R$):',String(loss.amount??0));if(amount===null)return
    const observation=prompt('Observação / motivo da alteração:',loss.observation??'');if(observation===null)return
    const {error}=await supabase.from('loss_events').update({amount:number(amount),observation}).eq('id',loss.id)
    setMessage(error?error.message:'Extravio atualizado nesta View.')
    if(!error){await loadGeneral();setSelected('');setTimeout(()=>setSelected(views.find(view=>view.id===selected)?.id??''),0)}
  }
  const saveReimbursement=async()=>{
    if(!supabase||!selected)return
    const amount=number(reimbursement)
    const {error}=await supabase.from('financial_views').update({notes:JSON.stringify({...notes(views.find(view=>view.id===selected)?.notes),reimbursement:amount})}).eq('id',selected)
    setMessage(error?error.message:'Reembolso salvo neste período.')
    if(!error)await refresh()
  }
  const reportFor=async(item:any)=>{
    try { await (await import('./financialReport')).downloadClosingPdf([item.closingRow],viewLosses,viewPeriods) }
    catch(error) { setMessage(error?.message??'Não foi possível gerar o relatório.') }
  }
  return <section className="finance-page">
    <section className="card finance-upload"><div><p className="eyebrow">FECHAMENTOS</p><h2>Novo fechamento quinzenal</h2><p>1. Informe o período. 2. Anexe a planilha. O sistema cria a View, registra o histórico e atualiza a base geral.</p></div><label className="finance-period">Período do fechamento<input value={uploadPeriod} onChange={event=>setUploadPeriod(event.target.value)} placeholder="Ex.: 33. 1Q DE AGOSTO" disabled={busy}/></label><a className="secondary" href="/templates/modelo-fechamento-financeiro.xlsx" download>Baixar modelo</a><label className={`upload-button ${!uploadPeriod.trim()||busy?'disabled':''}`}>Anexar planilha<input type="file" accept=".xlsx" onChange={choose} disabled={!uploadPeriod.trim()||busy}/></label></section>
    <section className="card finance-history"><div><p className="eyebrow">BASE HISTÓRICA</p><h2>Substituir base financeira</h2><p>Importe o Controle Financeiro completo. A ação atualiza Cadastros, recria as Views, os Fechamentos e os Extravios.</p></div><label className={`history-upload ${busy?'disabled':''}`}>Importar base completa<input type="file" accept=".xlsx" onChange={chooseHistory} disabled={busy}/></label></section>
    {message&&<p className="form-message">{message}</p>}
    <section className="finance-summary"><article className="metric"><span>Views salvas</span><strong>{views.length}</strong></article><article className="metric"><span>Itens na base geral</span><strong>{general.items}</strong></article><article className="metric"><span>Pacotes na base geral</span><strong>{general.packages.toLocaleString('pt-BR')}</strong></article><article className="metric red"><span>Extravios na base geral</span><strong>{general.losses} · R$ {general.lossAmount.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})}</strong></article></section>
    <section className="card"><div className="finance-head"><div><p className="eyebrow">VIEWS SALVAS</p><h2>Consultar fechamento</h2></div><button className="secondary" onClick={()=>void refresh()}>Atualizar</button></div><select className="view-select" value={selected} onChange={event=>setSelected(event.target.value)}><option value="">Selecione uma View</option>{views.map(view=><option key={view.id} value={view.id}>{view.title} · {new Date(view.created_at).toLocaleString('pt-BR')}</option>)}</select></section>
    {selected&&<>{(()=>{const totalImile=viewTotals.reduce((sum,item)=>sum+number(item.net),0),totalDrops=details.reduce((sum,item)=>sum+number(item.receivable_amount),0),reimbursementValue=number(reimbursement),talitaJorge=totalImile-totalDrops+reimbursementValue;return <><section className="card finance-preview"><label>Reembolso iMile deste período<input type="number" step="0.01" value={reimbursement} onChange={event=>setReimbursement(event.target.value)}/></label><button className="secondary" onClick={()=>void saveReimbursement()}>Salvar reembolso</button><strong>Pagamento Talita e Jorge: {money(talitaJorge)}</strong></section><section className="finance-summary"><article className="metric"><span>Linhas em Fechamento</span><strong>{details.length}</strong></article><article className="metric red"><span>Linhas em Extravios</span><strong>{viewLosses.length}</strong></article><article className="metric"><span>Total líquido iMile</span><strong>{money(totalImile)}</strong></article><article className="metric"><span>Pagamento aos Drops</span><strong>{money(totalDrops)}</strong></article></section></>})()}<section className="card"><h2>Fechamento</h2><div className="table-wrap"><table><thead><tr><th>Período</th><th>Parceiro</th><th>Drop</th><th>Quantidade de pacotes</th><th>Total padrão</th><th>Valor acordado</th><th>Valor pago AGU bruto</th><th>Extravio</th><th>Total a receber do AGU</th><th>Relatório</th></tr></thead><tbody>{details.map(item=><tr key={item.id}><td>{item.period?.label}</td><td>{item.period?.partner}</td><td>{item.drop_name_snapshot}</td><td>{item.quantity_packages}</td><td>{money(item.standard_total)}</td><td>{money(item.agreed_value)}</td><td>{money(item.gross_amount)}</td><td>{money(item.loss_amount)}</td><td>{money(item.receivable_amount)}</td><td><button className="table-action" onClick={()=>reportFor(item)}>Gerar PDF</button></td></tr>)}</tbody></table></div></section><section className="card"><h2>Extravios</h2><div className="table-wrap"><table><thead><tr><th>Período</th><th>Parceiro</th><th>Drop</th><th>Waybill</th><th>Status</th><th>Valor</th><th>Observação</th><th>Ação</th></tr></thead><tbody>{viewLosses.map(item=><tr key={item.id}><td>{item.period_label}</td><td>{item.partner}</td><td>{item.drop_name_snapshot}</td><td>{item.waybill}</td><td>{item.status}</td><td>{money(item.amount)}</td><td>{item.observation}</td><td><button className="table-action" onClick={()=>void editLoss(item)}>Editar</button></td></tr>)}</tbody></table></div></section></>}
  </section>
}
