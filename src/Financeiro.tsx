// @ts-nocheck
import { ChangeEvent, useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from './lib/supabase'

type Row = Record<string, unknown>
type View = { id:string; title:string; source_file_name:string; source_rows:number; import_status:string; created_at:string }
const text=(value:unknown)=>String(value??'').trim()
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

export default function Financeiro(){
  const [views,setViews]=useState<View[]>([])
  const [selected,setSelected]=useState('')
  const [closing,setClosing]=useState<Row[]>([])
  const [losses,setLosses]=useState<Row[]>([])
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
      setDetails((items??[]).map(item=>({...item,period:(periods??[]).find(period=>period.id===item.financial_period_id)})))
      setViewLosses(loss??[])
    }
    void load()
  },[selected])

  const choose=async(event:ChangeEvent<HTMLInputElement>)=>{
    const file=event.target.files?.[0]
    if(!file)return
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
      const invalid=close.filter(row=>!required(row,['Periodo','Parceiro','Drop'])||!text(row.QuantidadePacote)||number(row.QuantidadePacote)<0).length+loss.filter(row=>!required(row,['Periodo','Parceiro','Drop'])||(text(row.DataRecebimento)&&!excelDate(row.DataRecebimento))).length
      setClosing(close);setLosses(loss);setTitle(file.name.replace(/\.[^.]+$/,''));setSourceFile(file.name)
      setMessage(invalid?`${invalid} linha(s) precisam ser corrigidas antes da importação.`:`Prévia pronta: ${close.length} itens de fechamento e ${loss.length} extravios. Ao criar a View, os dados também entrarão no consolidado geral.`)
    }catch(error){setClosing([]);setLosses([]);setMessage(error instanceof Error?error.message:'Não foi possível ler a planilha.')}
  }
  const invalid=useMemo(()=>closing.some(row=>!required(row,['Periodo','Parceiro','Drop'])||!text(row.QuantidadePacote)||number(row.QuantidadePacote)<0)||losses.some(row=>!required(row,['Periodo','Parceiro','Drop'])||(text(row.DataRecebimento)&&!excelDate(row.DataRecebimento))),[closing,losses])

  const importView=async()=>{
    if(!supabase||!closing.length||invalid)return
    setBusy(true);setMessage('Importando View...')
    try{
      const {data:view,error:viewError}=await supabase.from('financial_views').insert({title,source_file_name:sourceFile||`${title}.xlsx`,source_rows:closing.length+losses.length,import_status:'rascunho'}).select().single()
      if(viewError)throw viewError
      const groups=[...new Map([...closing,...losses].map(row=>[`${text(row.Periodo)}|${text(row.Parceiro)}`,{label:text(row.Periodo),partner:text(row.Parceiro)}])).values()]
      const {data:periods,error:periodError}=await supabase.from('financial_periods').insert(groups.map(group=>({...group,financial_view_id:view.id,status:'aberto'}))).select()
      if(periodError)throw periodError
      const periodIndex=new Map((periods??[]).map(period=>[`${period.label}|${period.partner}`,period.id]))
      const chunks=<T,>(rows:T[])=>Array.from({length:Math.ceil(rows.length/400)},(_,index)=>rows.slice(index*400,index*400+400))
      for(const part of chunks(closing)){const {error}=await supabase.from('financial_drop_items').insert(part.map(row=>({financial_period_id:periodIndex.get(`${text(row.Periodo)}|${text(row.Parceiro)}`),drop_name_snapshot:text(row.Drop),quantity_packages:number(row.QuantidadePacote),unit_value:0,reimbursement:0})));if(error)throw error}
      for(const part of chunks(losses)){const {error}=await supabase.from('loss_events').insert(part.map(row=>({financial_period_id:periodIndex.get(`${text(row.Periodo)}|${text(row.Parceiro)}`),partner:text(row.Parceiro),period_label:text(row.Periodo),drop_name_snapshot:text(row.Drop),waybill:text(row.Waybill),label_code:text(row.CodigoEtiqueta),bag_code:text(row.Saca),status:text(row.Status),seller:text(row.Seller),received_at:excelDate(row.DataRecebimento),amount:number(row.ValorExtravio),observation:text(row.Obs)})));if(error)throw error}
      await supabase.from('financial_views').update({import_status:'importado'}).eq('id',view.id)
      setClosing([]);setLosses([]);setSourceFile('');setSelected(view.id)
      setMessage('View importada com sucesso e consolidado geral atualizado.')
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
    <section className="card finance-upload"><div><p className="eyebrow">FECHAMENTOS</p><h2>Nova View financeira</h2><p>Envie o modelo quinzenal. Cada arquivo cria uma versão independente e atualiza a base geral.</p></div><a className="secondary" href="/templates/modelo-fechamento-financeiro.xlsx" download>Baixar modelo</a><label className="upload-button">Selecionar planilha<input type="file" accept=".xlsx" onChange={choose}/></label></section>
    {closing.length>0&&<section className="card finance-preview"><label>Nome da View<input value={title} onChange={event=>setTitle(event.target.value)}/></label><strong>{closing.length} itens · {losses.length} extravios</strong><button className="primary compact" disabled={busy||invalid} onClick={()=>void importView}>{busy?'Importando...':'Criar View'}</button></section>}
    {message&&<p className="form-message">{message}</p>}
    <section className="finance-summary"><article className="metric"><span>Views salvas</span><strong>{views.length}</strong></article><article className="metric"><span>Itens na base geral</span><strong>{general.items}</strong></article><article className="metric"><span>Pacotes na base geral</span><strong>{general.packages.toLocaleString('pt-BR')}</strong></article><article className="metric red"><span>Extravios na base geral</span><strong>{general.losses} · R$ {general.lossAmount.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})}</strong></article></section>
    <section className="card"><div className="finance-head"><div><p className="eyebrow">VIEWS SALVAS</p><h2>Consultar fechamento</h2></div><button className="secondary" onClick={()=>void refresh()}>Atualizar</button></div><select className="view-select" value={selected} onChange={event=>setSelected(event.target.value)}><option value="">Selecione uma View</option>{views.map(view=><option key={view.id} value={view.id}>{view.title} · {new Date(view.created_at).toLocaleString('pt-BR')}</option>)}</select></section>
    {selected&&<><section className="finance-summary"><article className="metric"><span>Itens por Drop</span><strong>{details.length}</strong></article><article className="metric red"><span>Extravios</span><strong>{viewLosses.length}</strong></article></section><section className="card"><h2>Itens da View</h2><div className="table-wrap"><table><thead><tr><th>Período</th><th>Parceiro</th><th>Drop</th><th>Pacotes</th><th>Valor unitário</th><th>Total</th></tr></thead><tbody>{details.map(item=><tr key={item.id}><td>{item.period?.label}</td><td>{item.period?.partner}</td><td>{item.drop_name_snapshot}</td><td>{item.quantity_packages}</td><td>R$ {Number(item.unit_value).toFixed(2)}</td><td>R$ {Number(item.total_amount).toFixed(2)}</td></tr>)}</tbody></table></div></section><section className="card"><h2>Extravios da View</h2><div className="table-wrap"><table><thead><tr><th>Drop</th><th>Waybill</th><th>Status</th><th>Valor</th><th>Observação</th><th>Ação</th></tr></thead><tbody>{viewLosses.map(item=><tr key={item.id}><td>{item.drop_name_snapshot}</td><td>{item.waybill}</td><td>{item.status}</td><td>R$ {Number(item.amount).toFixed(2)}</td><td>{item.observation}</td><td><button className="table-action" onClick={()=>void editLoss(item)}>Editar</button></td></tr>)}</tbody></table></div></section></>}
  </section>
}
