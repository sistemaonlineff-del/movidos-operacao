// @ts-nocheck
import { ChangeEvent, useEffect, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from './lib/supabase'

type Row = Record<string, unknown>
type View = { id:string; title:string; source_file_name:string; source_rows:number; import_status:string; created_at:string }
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
const hasInvalidRows=(closing:Row[],losses:Row[])=>closing.some(row=>!required(row,['Periodo','Parceiro','Drop'])||!text(row.QuantidadePacote)||number(row.QuantidadePacote)<0)||losses.some(row=>!required(row,['Periodo','Parceiro','Drop'])||(text(row.DataRecebimento)&&!excelDate(row.DataRecebimento)))

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
  const [general,setGeneral]=useState({items:0,packages:0,losses:0,lossAmount:0})

  const loadGeneral=async()=>{
    if(!supabase)return
    const readAll=async(table:'financial_drop_items'|'loss_events',columns:string)=>{
      let from=0, rows:Row[]=[]
      while(true){
        const {data,error}=await supabase.from(table).select(columns).range(from,from+999)
        if(error)throw error
        rows=rows.concat((data??[]) as Row[])
        if((data??[]).length<1000)return rows
        from+=1000
      }
    }
    try{
      const [items,lossRows]=await Promise.all([readAll('financial_drop_items','quantity_packages'),readAll('loss_events','amount')])
      setGeneral({items:items.length,packages:items.reduce((sum,row)=>sum+number(row.quantity_packages),0),losses:lossRows.length,lossAmount:lossRows.reduce((sum,row)=>sum+number(row.amount),0)})
    }catch(error){setMessage(error instanceof Error?error.message:'Não foi possível atualizar a base geral.')}
  }
  const latestAgreedValues=async()=>{
    if(!supabase)return new Map<string,number>()
    let from=0, rows:Row[]=[]
    while(true){
      const {data,error}=await supabase.from('financial_drop_items').select('drop_name_snapshot,unit_value,created_at').gt('unit_value',0).order('created_at',{ascending:false}).range(from,from+999)
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
    const {data,error}=await supabase.from('financial_views').select('*').order('created_at',{ascending:false})
    if(error){setMessage('Execute a migração financeira no Supabase antes de usar este módulo.');return}
    setViews(data??[])
    await loadGeneral()
  }
  useEffect(()=>{void refresh()},[])
  useEffect(()=>{
    if(!selected||!supabase)return
    const load=async()=>{
      const {data:periods}=await supabase.from('financial_periods').select('id,label,partner,net_amount,status').eq('financial_view_id',selected)
      const ids=(periods??[]).map(item=>item.id)
      if(!ids.length){setDetails([]);setViewLosses([]);return}
      const [{data:items},{data:loss}]=await Promise.all([supabase.from('financial_drop_items').select('*').in('financial_period_id',ids).order('drop_name_snapshot'),supabase.from('loss_events').select('*').in('financial_period_id',ids).order('created_at')])
      const lossByDropPeriod=new Map<string,number>()
      ;(loss??[]).forEach(item=>{const key=`${text(item.period_label)}|${dropKey(item.drop_name_snapshot)}`;lossByDropPeriod.set(key,(lossByDropPeriod.get(key)??0)+number(item.amount))})
      setDetails((items??[]).map(item=>{const period=(periods??[]).find(period=>period.id===item.financial_period_id);const quantity=number(item.quantity_packages);const agreed=number(item.unit_value);const lossAmount=lossByDropPeriod.get(`${text(period?.label)}|${dropKey(item.drop_name_snapshot)}`)??0;const gross=quantity*agreed;return {...item,period,standard_total:quantity*.25,agreed_value:agreed,gross_amount:gross,loss_amount:lossAmount,receivable_amount:gross-lossAmount}}))
      setViewLosses(loss??[])
    }
    void load()
  },[selected])

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
      if(!hasColumns(closeHeaders,['Periodo','Parceiro','Drop','QuantidadePacote'])||!hasColumns(lossHeaders,['Periodo','Parceiro','Drop','Waybill','CodigoEtiqueta','Saca','Status','Seller','DataRecebimento','ValorExtravio','Obs']))throw new Error('As colunas do modelo foram alteradas. Baixe o modelo atualizado e mantenha os cabeçalhos.')
      if(!close.length)throw new Error('A aba Fechamento não possui linhas para importar.')
      const closingForPeriod=close.map(row=>({...row,Periodo:period}) as Row)
      const lossesForPeriod=loss.map(row=>({...row,Periodo:period}) as Row)
      const invalid=closingForPeriod.filter(row=>!required(row,['Periodo','Parceiro','Drop'])||!text(row.QuantidadePacote)||number(row.QuantidadePacote)<0).length+lossesForPeriod.filter(row=>!required(row,['Periodo','Parceiro','Drop'])||(text(row.DataRecebimento)&&!excelDate(row.DataRecebimento))).length
      setClosing(closingForPeriod);setLosses(lossesForPeriod);setTitle(period);setSourceFile(file.name)
      if(invalid){setMessage(`${invalid} linha(s) precisam ser corrigidas antes da importação.`);return}
      await importView(closingForPeriod,lossesForPeriod,period,file.name)
    }catch(error){setClosing([]);setLosses([]);setMessage(error instanceof Error?error.message:'Não foi possível ler a planilha.')}
  }
  const chooseHistory=async(event:ChangeEvent<HTMLInputElement>)=>{
    const file=event.target.files?.[0]
    if(!file||!supabase)return
    if(!confirm('Esta ação apaga todas as Views financeiras, fechamentos e extravios atuais e substitui tudo pelo Pasta1.xlsx. Deseja continuar?')){event.target.value='';return}
    setBusy(true);setMessage('Lendo e substituindo a base histórica...')
    try{
      const workbook=XLSX.read(await file.arrayBuffer(),{type:'array'})
      const sheet=workbook.Sheets.Planilha1
      if(!sheet)throw new Error('Use o Pasta1.xlsx com a aba Planilha1.')
      const rows=XLSX.utils.sheet_to_json<Row>(sheet,{defval:''})
      const headers=['PERÍODO','DROP','PARCEIRO','TOTAL PACOTE','VALOR ACORDADO']
      if(!rows.length||!headers.every(header=>Object.prototype.hasOwnProperty.call(rows[0],header)))throw new Error('As colunas do Pasta1.xlsx não correspondem ao histórico esperado.')
      const payload=rows.map(row=>({period:text(row['PERÍODO']),drop:text(row.DROP),partner:text(row.PARCEIRO),quantity:number(row['TOTAL PACOTE']),agreed:number(row['VALOR ACORDADO'])})).filter(row=>row.period&&row.drop)
      const {data:{session}}=await supabase.auth.getSession()
      const response=await fetch('/api/financial/rebuild-history',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${session?.access_token??''}`},body:JSON.stringify({rows:payload})})
      const result=await response.json()
      if(!response.ok)throw new Error(result.error??'Não foi possível substituir a base histórica.')
      setSelected('')
      await refresh()
      setSelected(result.lastViewId)
      setMessage(`Histórico substituído: ${result.views} Views e ${result.rows} linhas de Fechamento importadas.`)
    }catch(error){setMessage(error instanceof Error?error.message:'Não foi possível importar o histórico.')}finally{setBusy(false);event.target.value=''}
  }
  const importView=async(sourceClosing=closing,sourceLosses=losses,sourceTitle=title,sourceFileName=sourceFile)=>{
    if(!supabase||!sourceClosing.length||hasInvalidRows(sourceClosing,sourceLosses))return
    setBusy(true);setMessage('Importando View...')
    try{
      const {data:view,error:viewError}=await supabase.from('financial_views').insert({title:sourceTitle,source_file_name:sourceFileName||`${sourceTitle}.xlsx`,source_rows:sourceClosing.length+sourceLosses.length,import_status:'rascunho'}).select().single()
      if(viewError)throw viewError
      const groups=[...new Map([...sourceClosing,...sourceLosses].map(row=>[`${text(row.Periodo)}|${text(row.Parceiro)}`,{label:text(row.Periodo),partner:text(row.Parceiro)}])).values()]
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
  return <section className="finance-page">
    <section className="card finance-upload"><div><p className="eyebrow">FECHAMENTOS</p><h2>Novo fechamento quinzenal</h2><p>1. Informe o período. 2. Anexe a planilha. O sistema cria a View, registra o histórico e atualiza a base geral.</p></div><label className="finance-period">Período do fechamento<input value={uploadPeriod} onChange={event=>setUploadPeriod(event.target.value)} placeholder="Ex.: 33. 1Q DE AGOSTO" disabled={busy}/></label><a className="secondary" href="/templates/modelo-fechamento-financeiro.xlsx" download>Baixar modelo</a><label className={`upload-button ${!uploadPeriod.trim()||busy?'disabled':''}`}>Anexar planilha<input type="file" accept=".xlsx" onChange={choose} disabled={!uploadPeriod.trim()||busy}/></label></section>
    <section className="card finance-history"><div><p className="eyebrow">BASE HISTÓRICA</p><h2>Substituir histórico financeiro</h2><p>Use apenas para reiniciar a base com o Pasta1.xlsx. Esta ação remove todas as Views, fechamentos e extravios atuais.</p></div><label className={`history-upload ${busy?'disabled':''}`}>Importar Pasta1.xlsx<input type="file" accept=".xlsx" onChange={chooseHistory} disabled={busy}/></label></section>
    {message&&<p className="form-message">{message}</p>}
    <section className="finance-summary"><article className="metric"><span>Views salvas</span><strong>{views.length}</strong></article><article className="metric"><span>Itens na base geral</span><strong>{general.items}</strong></article><article className="metric"><span>Pacotes na base geral</span><strong>{general.packages.toLocaleString('pt-BR')}</strong></article><article className="metric red"><span>Extravios na base geral</span><strong>{general.losses} · R$ {general.lossAmount.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})}</strong></article></section>
    <section className="card"><div className="finance-head"><div><p className="eyebrow">VIEWS SALVAS</p><h2>Consultar fechamento</h2></div><button className="secondary" onClick={()=>void refresh()}>Atualizar</button></div><select className="view-select" value={selected} onChange={event=>setSelected(event.target.value)}><option value="">Selecione uma View</option>{views.map(view=><option key={view.id} value={view.id}>{view.title} · {new Date(view.created_at).toLocaleString('pt-BR')}</option>)}</select></section>
    {selected&&<><section className="finance-summary"><article className="metric"><span>Linhas em Fechamento</span><strong>{details.length}</strong></article><article className="metric red"><span>Linhas em Extravios</span><strong>{viewLosses.length}</strong></article></section><section className="card"><h2>Fechamento</h2><div className="table-wrap"><table><thead><tr><th>Período</th><th>Parceiro</th><th>Drop</th><th>Quantidade de pacotes</th><th>Total padrão</th><th>Valor acordado</th><th>Valor pago AGU bruto</th><th>Extravio</th><th>Total a receber do AGU</th></tr></thead><tbody>{details.map(item=><tr key={item.id}><td>{item.period?.label}</td><td>{item.period?.partner}</td><td>{item.drop_name_snapshot}</td><td>{item.quantity_packages}</td><td>R$ {Number(item.standard_total).toFixed(2)}</td><td>R$ {Number(item.agreed_value).toFixed(2)}</td><td>R$ {Number(item.gross_amount).toFixed(2)}</td><td>R$ {Number(item.loss_amount).toFixed(2)}</td><td>R$ {Number(item.receivable_amount).toFixed(2)}</td></tr>)}</tbody></table></div></section><section className="card"><h2>Extravios</h2><div className="table-wrap"><table><thead><tr><th>Período</th><th>Parceiro</th><th>Drop</th><th>Waybill</th><th>Status</th><th>Valor</th><th>Observação</th><th>Ação</th></tr></thead><tbody>{viewLosses.map(item=><tr key={item.id}><td>{item.period_label}</td><td>{item.partner}</td><td>{item.drop_name_snapshot}</td><td>{item.waybill}</td><td>{item.status}</td><td>R$ {Number(item.amount).toFixed(2)}</td><td>{item.observation}</td><td><button className="table-action" onClick={()=>void editLoss(item)}>Editar</button></td></tr>)}</tbody></table></div></section></>}
  </section>
}
