// @ts-nocheck
import { ChangeEvent, useEffect, useRef, useState } from 'react'
import { useAccess } from './access'
import DashboardNotes from './DashboardNotes'
import * as XLSX from 'xlsx'
import { allocateClosingPackages, buildDetails, buildTotals, closingOperators, closingWindow, financialPartner, notes } from './financialData'
import { readFinancialRows } from './financialStore'
import { supabase } from './lib/supabase'
import { normalizePartner } from './dropOptions'
import { closingIdentity, downloadClosingTemplate, readClosingSummary } from './closingSpreadsheet'

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
  const {can,isAdmin}=useAccess()
  const canManage=can('financeiro_manage')
  const actionRunning=useRef(false)
  const [viewAction,setViewAction]=useState<'rename'|'deactivate'|null>(null)
  const [newTitle,setNewTitle]=useState(''),[actionReason,setActionReason]=useState(''),[viewNote,setViewNote]=useState('')
  const [views,setViews]=useState<View[]>([])
  const [selected,setSelected]=useState('')
  const [closing,setClosing]=useState<Row[]>([])
  const [losses,setLosses]=useState<Row[]>([])
  const [uploadPeriod,setUploadPeriod]=useState('')
  const [closingStart,setClosingStart]=useState(''),[closingEnd,setClosingEnd]=useState('')
  const [pendingImport,setPendingImport]=useState<any>(null)
  const importRunning=useRef(false)
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

  const latestAgreedValues=async(periods)=>{
    if(!supabase)return new Map<string,number>()
    const byId=new Map(periods.map(period=>[period.id,period]))
    let from=0, rows:Row[]=[]
    while(true){
      const {data,error}=await supabase.from('financial_drop_items').select('financial_period_id,drop_name_snapshot,unit_value,created_at').eq('is_active',true).gt('unit_value',0).order('created_at',{ascending:false}).range(from,from+999)
      if(error)throw error
      rows=rows.concat((data??[]) as Row[])
      if((data??[]).length<1000)break
      from+=1000
    }
    const agreed=new Map<string,number>()
    rows.forEach(row=>{const period=byId.get(row.financial_period_id);if(!period)return;const identity=`${dropKey(row.drop_name_snapshot)}|${closingIdentity(financialPartner(period),period.reference_cnpj)}`;if(!agreed.has(identity))agreed.set(identity,number(row.unit_value))})
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
    let current=true
    setDetails([]);setViewPeriods([]);setViewLosses([]);setViewTotals([])
    const load=async()=>{
      try {
        const [allPeriods,allItems,allLosses,allHistory,allDrops]=await Promise.all(['financial_periods','financial_drop_items','loss_events','financial_payment_history','drops'].map(readFinancialRows))
        const periods=allPeriods.filter(period=>period.financial_view_id===selected)
        const ids=new Set(periods.map(period=>period.id))
        const items=allItems.filter(item=>ids.has(item.financial_period_id)), loss=allLosses.filter(item=>ids.has(item.financial_period_id)), history=allHistory.filter(item=>ids.has(item.financial_period_id))
        const rows=buildDetails(history,items,loss,periods,allDrops)
        if(!current)return
        setDetails(rows.map(row=>({...row,closingRow:row,period:periods.find(period=>period.id===row.periodId),drop_name_snapshot:row.drop,quantity_packages:row.packages,standard_total:row.packages*.25,agreed_value:row.unit,gross_amount:row.subtotal,loss_amount:row.loss,receivable_amount:row.receivable})))
        setViewPeriods(periods);setViewLosses(loss);setViewTotals(buildTotals(rows,loss,periods,views.filter(view=>view.id===selected)))
      } catch(error) { if(current){setMessage(error?.message??'Não foi possível carregar o fechamento.');setDetails([]);setViewLosses([]);setViewTotals([])} }
    }
    void load()
    return ()=>{current=false}
  },[selected,views])
  useEffect(()=>{setReimbursement(String(reimbursementFromNotes(views.find(view=>view.id===selected)?.notes)));setViewNote(notes(views.find(view=>view.id===selected)?.notes).annotation??'');setViewAction(null)},[selected,views])
  const changeView=async(event)=>{
    event.preventDefault()
    if(!supabase||!canManage||actionRunning.current)return
    const view=views.find(view=>view.id===selected)
    if(!view||!viewAction)return
    actionRunning.current=true;setBusy(true)
    try{
      const {error}=await supabase.rpc('change_financial_view',{view_id:view.id,expected_title:view.title,action:viewAction,reason:actionReason,new_title:viewAction==='rename'?newTitle.trim():null})
      if(error)throw error
      setViewAction(null);setSelected('');setDetails([]);setViewPeriods([]);setViewLosses([]);setViewTotals([])
      await refresh();setMessage(viewAction==='rename'?'Período corrigido sem reimportar valores.':'View excluída dos totais. Histórico preservado.')
    }catch(error){setMessage(error?.message??'Não foi possível alterar a View.')}finally{actionRunning.current=false;setBusy(false)}
  }
  const saveViewNote=async()=>{
    if(!supabase||!canManage||busy)return
    const view=views.find(view=>view.id===selected);if(!view)return
    setBusy(true)
    let query=supabase.from('financial_views').update({notes:JSON.stringify({...notes(view.notes),annotation:viewNote})}).eq('id',view.id).eq('is_active',true)
    query=view.notes==null?query.is('notes',null):query.eq('notes',view.notes)
    const result=await query.select('id')
    setBusy(false)
    if(result.error||result.data?.length!==1){setMessage(result.error?.message??'A anotação mudou. Atualize antes de salvar.');return}
    await refresh();setMessage('Anotação salva nesta View.')
  }

  const choose=async(event:ChangeEvent<HTMLInputElement>)=>{
    if(!canManage||busy||pendingImport||importRunning.current)return
    const file=event.target.files?.[0]
    if(!file)return
    const period=uploadPeriod.trim()
    if(!period){setMessage('Informe o período deste fechamento antes de anexar a planilha.');event.target.value='';return}
    setMessage('')
    try{
      closingWindow(closingStart,closingEnd,period)
      const workbook=XLSX.read(await file.arrayBuffer(),{type:'array',cellDates:true})
      const closeSheet=workbook.Sheets['Fechamento'], lossSheet=workbook.Sheets['Extravios']
      if(!closeSheet||!lossSheet)throw new Error('Use o Modelo_Fechamento_Financeiro.xlsx, com as abas Fechamento e Extravios.')
      const close=XLSX.utils.sheet_to_json<Row>(closeSheet,{defval:''}), loss=XLSX.utils.sheet_to_json<Row>(lossSheet,{defval:''})
      const closeHeaders=(XLSX.utils.sheet_to_json(closeSheet,{header:1,defval:''})[0]??[]) as unknown[]
      const lossHeaders=(XLSX.utils.sheet_to_json(lossSheet,{header:1,defval:''})[0]??[]) as unknown[]
      if(!hasColumns(closeHeaders,['CNPJReferencia'])||!hasColumns(lossHeaders,['CNPJReferencia']))throw new Error('Baixe o modelo atualizado: a coluna CNPJReferencia Ã© obrigatÃ³ria nas duas abas.')
      if(!hasColumns(closeHeaders,['Periodo','Parceiro','Drop','QuantidadePacote'])||!hasColumns(lossHeaders,['Periodo','Parceiro','Drop','Waybill','CodigoEtiqueta','Saca','Status','Seller','DataRecebimento','ValorExtravio','Obs']))throw new Error('As colunas do modelo foram alteradas. Baixe o modelo atualizado e mantenha os cabeçalhos.')
      if(!close.length)throw new Error('A aba Fechamento não possui linhas para importar.')
      for(const row of [...close,...loss]){
        if(text(row.Periodo)&&text(row.Periodo)!==period)throw new Error(`O período ${text(row.Periodo)} da planilha não corresponde ao fechamento ${period}.`)
      }
      const closingForPeriod=close.map(row=>({...row,Periodo:period,Parceiro:normalizePartner(text(row.Parceiro)),CNPJReferencia:referenceCnpj(row.CNPJReferencia)}) as Row)
      const lossesForPeriod=loss.map(row=>({...row,Periodo:period,Parceiro:normalizePartner(text(row.Parceiro)),CNPJReferencia:referenceCnpj(row.CNPJReferencia)}) as Row)
      const invalid=closingForPeriod.filter(row=>!required(row,['Periodo','Parceiro','Drop','CNPJReferencia'])||!validReferenceCnpj(row.CNPJReferencia)||!text(row.QuantidadePacote)||number(row.QuantidadePacote)<0).length+lossesForPeriod.filter(row=>!required(row,['Periodo','Parceiro','Drop','CNPJReferencia'])||!validReferenceCnpj(row.CNPJReferencia)||(text(row.DataRecebimento)&&!excelDate(row.DataRecebimento))).length
      const references=[...new Map([...closingForPeriod,...lossesForPeriod].map(row=>[closingIdentity(row.Parceiro,row.CNPJReferencia),{partner:text(row.Parceiro),referenceCnpj:referenceCnpj(row.CNPJReferencia)}])).values()]
      const summary=readClosingSummary(workbook,references,period)
      const closingWithPayments=closingForPeriod.map(row=>({...row,...summary.get(closingIdentity(row.Parceiro,row.CNPJReferencia))}))
      setClosing(closingWithPayments);setLosses(lossesForPeriod);setTitle(period);setSourceFile(file.name)
      if(invalid){setMessage(`${invalid} linha(s) precisam ser corrigidas antes da importação.`);return}
      await importView(closingWithPayments,lossesForPeriod,period,file.name,summary)
    }catch(error){setClosing([]);setLosses([]);setMessage(text(error?.message)||'Não foi possível ler a planilha.')}finally{event.target.value=''}
  }
  const chooseHistory=async(event:ChangeEvent<HTMLInputElement>)=>{
    const file=event.target.files?.[0]
    if(!file||!supabase||!isAdmin||busy)return
    if(!confirm('Esta ação desativa TODAS as Views financeiras, fechamentos e extravios atuais e substitui a base ativa pelos dados deste arquivo. Não use para um novo fechamento ou para corrigir somente uma quinzena. Deseja continuar?')){event.target.value='';return}
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
  const importView=async(sourceClosing=closing,sourceLosses=losses,sourceTitle=title,sourceFileName=sourceFile,summary=new Map(),confirmed=null)=>{
    if(!supabase||!canManage||importRunning.current||!sourceClosing.length||hasInvalidRows(sourceClosing,sourceLosses))return
    importRunning.current=true
    setBusy(true);setMessage('Importando View...')
    let stage='verificar a estrutura do banco',createdViewId=''
    try{
      const window=closingWindow(closingStart,closingEnd,sourceTitle)
      for(const [table,columns] of [
        ['financial_views','id,title,source_file_name,source_rows,import_status'],
        ['financial_periods','id,label,partner,logistics_partner,reference_cnpj,net_amount,payment_date,financial_view_id,status'],
        ['financial_drop_items','financial_period_id,drop_name_snapshot,quantity_packages,unit_value,reimbursement,is_active,created_at,registration_snapshot'],
        ['loss_events','financial_period_id,drop_id,partner,period_label,drop_name_snapshot,waybill,label_code,bag_code,status,seller,received_at,amount,observation'],
      ]){
        const {error}=await supabase.from(table).select(columns).limit(0)
        if(error){
          const migration=['42703','PGRST204'].includes(error.code)?text(error.message).includes('registration_snapshot')?' Execute no Supabase a migração 20261014120000_financial_registration_snapshots.sql e tente novamente.':text(error.message).includes('logistics_partner')?' Execute no Supabase a migração 20260917130000_prepare_financial_logistics_columns.sql e tente novamente.':'':''
          throw {message:`${text(error.message)||'Estrutura indisponível.'}${migration}`,code:error.code}
        }
      }
      stage='consultar os valores acordados'
      const existingPeriods=await readFinancialRows('financial_periods')
      const agreedByDrop=await latestAgreedValues(existingPeriods)
      stage='salvar a copia dos dados cadastrais'
      const registrations=await readFinancialRows('operation_drops')
      const identify=row=>`${dropKey(row.Drop)}|${closingIdentity(row.Parceiro,row.CNPJReferencia)}`
      const operators=new Map([...sourceClosing,...sourceLosses].map(row=>[identify(row),closingOperators(row.Drop,row.Parceiro,registrations,window.start,window.end,agreedByDrop.get(identify(row))??0)]))
      const plan=sourceClosing.map(row=>({row,operators:operators.get(identify(row))}))
      const lossPlan=sourceLosses.map(row=>({row,operators:operators.get(identify(row))}))
      const fingerprint=JSON.stringify([...operators].map(([identity,entries])=>[identity,entries.map(entry=>({...entry,registration_snapshot:{...entry.registration_snapshot,capturedAt:undefined}}))]))
      if(confirmed&&confirmed.fingerprint!==fingerprint)throw new Error('Os cadastros ou valores mudaram durante a conferencia. Cancele e anexe novamente a planilha para revisar a divisao.')
      const repeated=[...sourceClosing,...sourceLosses].find(row=>existingPeriods.some(period=>dropKey(period.label)===dropKey(row.Periodo)&&closingIdentity(financialPartner(period),period.reference_cnpj)===closingIdentity(row.Parceiro,row.CNPJReferencia)))
      if(repeated)throw new Error('Já existe fechamento ativo para este período, parceiro e CNPJ. Corrija o período ou exclua logicamente a View anterior antes de importar novamente.')
      if(!confirmed&&(plan.some(entry=>entry.operators.length>1)||lossPlan.some(entry=>entry.operators.length>1))){
        setPendingImport({sourceClosing,sourceLosses,sourceTitle,sourceFileName,summary,plan,lossPlan,fingerprint,quantities:plan.map(entry=>entry.operators.length===1?[String(number(entry.row.QuantidadePacote))]:entry.operators.map(()=>'')),lossOwners:lossPlan.map(entry=>entry.operators.length===1?entry.operators[0].registration_snapshot.dropId:'')})
        setMessage('Troca de responsavel nesta quinzena. Confira a divisao antes de importar.');return
      }
      stage='conferir a divisao de pacotes e extravios'
      const allocated=plan.map((entry,index)=>allocateClosingPackages(entry.row.QuantidadePacote,entry.operators,confirmed?.quantities[index]))
      const lossOwners=lossPlan.map((entry,index)=>{
        const owner=confirmed?.lossOwners[index]??entry.operators[0].registration_snapshot.dropId
        if(!entry.operators.some(operator=>operator.registration_snapshot.dropId===owner))throw new Error(`Selecione o responsavel pelo extravio ${text(entry.row.Waybill)||index+1}.`)
        return owner
      })
      setPendingImport(null)
      stage='criar a View'
      const {data:view,error:viewError}=await supabase.from('financial_views').insert({title:sourceTitle,source_file_name:sourceFileName||`${sourceTitle}.xlsx`,source_rows:sourceClosing.length+sourceLosses.length,import_status:'rascunho',notes:JSON.stringify({operationPeriod:window})}).select().single()
      if(viewError)throw viewError
      createdViewId=view.id
      stage='gravar os períodos'
      const groups=[...new Map([...sourceClosing,...sourceLosses].map(row=>[`${text(row.Periodo)}|${closingIdentity(row.Parceiro,row.CNPJReferencia)}`,{label:text(row.Periodo),partner:text(row.Parceiro),logistics_partner:text(row.Parceiro),reference_cnpj:referenceCnpj(row.CNPJReferencia),...(summary.get(closingIdentity(row.Parceiro,row.CNPJReferencia))??{})}])).values()]
      const {data:periods,error:periodError}=await supabase.from('financial_periods').insert(groups.map(group=>({...group,financial_view_id:view.id,status:'aberto'}))).select()
      if(periodError)throw periodError
      const periodIndex=new Map((periods??[]).map(period=>[`${period.label}|${closingIdentity(period.partner,period.reference_cnpj)}`,period.id]))
      const chunks=<T,>(rows:T[])=>Array.from({length:Math.ceil(rows.length/400)},(_,index)=>rows.slice(index*400,index*400+400))
      stage='gravar os itens do fechamento'
      const capturedItems=sourceClosing.flatMap((row,index)=>allocated[index].map(allocation=>({financial_period_id:periodIndex.get(`${text(row.Periodo)}|${closingIdentity(row.Parceiro,row.CNPJReferencia)}`),drop_name_snapshot:text(row.Drop),...allocation,reimbursement:0})))
      for(const part of chunks(capturedItems)){const {error}=await supabase.from('financial_drop_items').insert(part);if(error)throw error}
      stage='gravar os extravios'
      const capturedLosses=sourceLosses.map((row,index)=>({financial_period_id:periodIndex.get(`${text(row.Periodo)}|${closingIdentity(row.Parceiro,row.CNPJReferencia)}`),drop_id:lossOwners[index],partner:text(row.Parceiro),period_label:text(row.Periodo),drop_name_snapshot:text(row.Drop),waybill:text(row.Waybill),label_code:text(row.CodigoEtiqueta),bag_code:text(row.Saca),status:text(row.Status),seller:text(row.Seller),received_at:excelDate(row.DataRecebimento),amount:number(row.ValorExtravio),observation:text(row.Obs)}))
      for(const part of chunks(capturedLosses)){const {error}=await supabase.from('loss_events').insert(part);if(error)throw error}
      stage='concluir a View'
      const {error:completeError}=await supabase.from('financial_views').update({import_status:'importado'}).eq('id',view.id)
      if(completeError)throw completeError
      setClosing([]);setLosses([]);setSourceFile('');setUploadPeriod('');setSelected(view.id)
      setMessage(`View de ${sourceTitle} importada com sucesso e consolidado geral atualizado.`)
      await refresh()
    }catch(error){setMessage(`Erro ao importar (${stage}): ${text(error?.message)||'Não foi possível confirmar a gravação.'}${text(error?.code)?` (código ${text(error.code)})`:''}${createdViewId?` A View ${createdViewId} pode estar incompleta. Não reenvie a planilha antes de conferir os registros já gravados.`:''}`)}finally{importRunning.current=false;setBusy(false)}
  }
  const editLoss=async(loss:any)=>{
    if(!supabase||!canManage)return
    const amount=prompt('Valor do extravio (R$):',String(loss.amount??0));if(amount===null)return
    const observation=prompt('Observação / motivo da alteração:',loss.observation??'');if(observation===null)return
    const {error}=await supabase.from('loss_events').update({amount:number(amount),observation}).eq('id',loss.id)
    setMessage(error?error.message:'Extravio atualizado nesta View.')
    if(!error){await loadGeneral();setSelected('');setTimeout(()=>setSelected(views.find(view=>view.id===selected)?.id??''),0)}
  }
  const saveReimbursement=async()=>{
    if(!supabase||!selected||!canManage||actionRunning.current)return
    const view=views.find(view=>view.id===selected)
    if(!view)return
    actionRunning.current=true;setBusy(true)
    const amount=number(reimbursement)
    try{
      let query=supabase.from('financial_views').update({notes:JSON.stringify({...notes(view.notes),reimbursement:amount})}).eq('id',selected).eq('is_active',true)
      query=view.notes==null?query.is('notes',null):query.eq('notes',view.notes)
      const result=await query.select('id')
      if(result.error||result.data?.length!==1)throw new Error(result.error?.message??'A View mudou. Atualize antes de salvar o reembolso.')
      await refresh();setMessage('Reembolso salvo neste período.')
    }catch(error){setMessage(error.message)}finally{actionRunning.current=false;setBusy(false)}
  }
  const reportFor=async(item:any)=>{
    try { await (await import('./financialReport')).downloadClosingPdf([item.closingRow],viewLosses,viewPeriods) }
    catch(error) { setMessage(error?.message??'Não foi possível gerar o relatório.') }
  }
  return <section className="finance-page">
    <DashboardNotes financialOnly />
    {selected&&canManage&&<section className="form-section"><div className="financial-actions"><button disabled={busy} onClick={()=>{setViewAction('rename');setNewTitle(views.find(view=>view.id===selected)?.title??'');setActionReason('')}}>Corrigir período</button><button disabled={busy} onClick={()=>{setViewAction('deactivate');setActionReason('')}}>Excluir view</button></div>{viewAction&&<form onSubmit={changeView}><h3>{viewAction==='rename'?'Corrigir período':'Excluir view dos totais'}</h3>{viewAction==='rename'&&<label>Novo período<input required minLength={3} maxLength={160} value={newTitle} onChange={event=>setNewTitle(event.target.value)}/></label>}<label>Motivo<input required minLength={5} value={actionReason} onChange={event=>setActionReason(event.target.value)}/></label><div className="financial-actions"><button type="button" disabled={busy} onClick={()=>setViewAction(null)}>Cancelar</button><button className="primary" disabled={busy}>{busy?'Salvando…':'Confirmar alteração'}</button></div></form>}</section>}
    {selected&&<section className="form-section"><label>Anotações desta view<textarea aria-label="Anotações desta view" value={viewNote} readOnly={!canManage} onChange={event=>setViewNote(event.target.value)}/></label>{canManage&&<button disabled={busy} onClick={()=>void saveViewNote()}>Salvar anotação da view</button>}</section>}
    <section className="card finance-upload"><div><p className="eyebrow">FECHAMENTOS</p><h2>Novo fechamento quinzenal</h2></div><label className="finance-period">Período do fechamento<input value={uploadPeriod} onChange={event=>setUploadPeriod(event.target.value)} placeholder="Ex.: 33. 1Q DE AGOSTO" disabled={busy||Boolean(pendingImport)}/></label><div className="closing-period-dates"><label>Início da quinzena<input aria-label="Início da quinzena" type="date" value={closingStart} disabled={busy||Boolean(pendingImport)} onChange={event=>setClosingStart(event.target.value)}/></label><label>Fim da quinzena<input aria-label="Fim da quinzena" type="date" value={closingEnd} disabled={busy||Boolean(pendingImport)} onChange={event=>setClosingEnd(event.target.value)}/></label></div><button type="button" className="secondary" onClick={()=>downloadClosingTemplate(uploadPeriod.trim())}>Baixar modelo</button><label className={`upload-button ${!uploadPeriod.trim()||busy||pendingImport?'disabled':''}`}>Anexar planilha<input type="file" accept=".xlsx" onChange={choose} disabled={!uploadPeriod.trim()||busy||Boolean(pendingImport)||!canManage}/></label></section>
    {pendingImport&&<form className="closing-allocation" aria-label="Divisão por responsável" onSubmit={event=>{event.preventDefault();void importView(pendingImport.sourceClosing,pendingImport.sourceLosses,pendingImport.sourceTitle,pendingImport.sourceFileName,pendingImport.summary,pendingImport)}}>
      <h2>Divisão por responsável</h2><p>{pendingImport.sourceTitle} · {closingStart} a {closingEnd}</p>
      {pendingImport.plan.map((entry,index)=><fieldset key={index} disabled={busy}><legend>{entry.row.Drop} · {entry.row.Parceiro} · {entry.row.CNPJReferencia} · Linha {index+1}</legend><p>Total importado: {number(entry.row.QuantidadePacote)} pacotes · Informados: {pendingImport.quantities[index].reduce((sum,value)=>sum+number(value),0)}</p>
        {entry.operators.map((operator,ownerIndex)=><div className="closing-allocation-row" key={operator.registration_snapshot.dropId}><div><strong>{operator.registration_snapshot.responsible||'Responsável não informado'}</strong><span>{operator.registration_snapshot.operationStartedAt||'Sem início informado'} a {operator.registration_snapshot.operationEndedAt||'Em operação'}</span><span>Valor acordado: {money(operator.unit_value)}</span></div><label>Pacotes<input aria-label={`Pacotes de ${operator.registration_snapshot.responsible} - linha ${index+1}`} type="number" min="0" max="2147483647" step="1" required readOnly={entry.operators.length===1} value={pendingImport.quantities[index][ownerIndex]} onChange={event=>setPendingImport(current=>({...current,quantities:current.quantities.map((values,rowIndex)=>rowIndex===index?values.map((value,position)=>position===ownerIndex?event.target.value:value):values)}))}/></label></div>)}
      </fieldset>)}
      {pendingImport.lossPlan.length>0&&<fieldset disabled={busy}><legend>Responsáveis pelos extravios</legend>{pendingImport.lossPlan.map((entry,index)=><label key={index}>{entry.row.Drop} · {entry.row.Waybill||`Ocorrência ${index+1}`} · {money(entry.row.ValorExtravio)}<select aria-label={`Responsável pelo extravio ${index+1}`} required value={pendingImport.lossOwners[index]} onChange={event=>setPendingImport(current=>({...current,lossOwners:current.lossOwners.map((value,position)=>position===index?event.target.value:value)}))}><option value="">Selecionar responsável</option>{entry.operators.map(operator=><option key={operator.registration_snapshot.dropId} value={operator.registration_snapshot.dropId}>{operator.registration_snapshot.responsible} · {operator.registration_snapshot.operationStartedAt||'Sem início'} a {operator.registration_snapshot.operationEndedAt||'Em operação'}</option>)}</select></label>)}</fieldset>}
      <div className="financial-actions"><button type="button" disabled={busy} onClick={()=>{setPendingImport(null);setClosing([]);setLosses([]);setSourceFile('');setMessage('Importação cancelada. Nenhum registro foi criado.')}}>Cancelar divisão</button><button className="primary" disabled={busy||!canManage}>{busy?'Importando…':'Confirmar divisão e importar'}</button></div>
    </form>}
    {isAdmin&&<details className="finance-history"><summary>Administração da base histórica</summary><section><h2>Substituir base financeira</h2><p>Esta operação desativa toda a base atual e invalida seus links de NF. Não use para importar uma nova quinzena ou corrigir um período.</p><label className={`history-upload ${busy?'disabled':''}`}>Importar base completa<input type="file" accept=".xlsx" onChange={chooseHistory} disabled={busy}/></label></section></details>}
    {message&&<p className="form-message">{message}</p>}
    <section className="finance-summary"><article className="metric"><span>Views salvas</span><strong>{views.length}</strong></article><article className="metric"><span>Itens na base geral</span><strong>{general.items}</strong></article><article className="metric"><span>Pacotes na base geral</span><strong>{general.packages.toLocaleString('pt-BR')}</strong></article><article className="metric red"><span>Extravios na base geral</span><strong>{general.losses} · R$ {general.lossAmount.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})}</strong></article></section>
    <section className="card"><div className="finance-head"><div><p className="eyebrow">VIEWS SALVAS</p><h2>Consultar fechamento</h2></div><button className="secondary" onClick={()=>void refresh()}>Atualizar</button></div><select className="view-select" value={selected} onChange={event=>setSelected(event.target.value)}><option value="">Selecione uma View</option>{views.map(view=><option key={view.id} value={view.id}>{view.title} · {new Date(view.created_at).toLocaleString('pt-BR')}</option>)}</select></section>
    {selected&&<>{(()=>{const totalImile=viewTotals.reduce((sum,item)=>sum+number(item.net),0),totalDrops=details.reduce((sum,item)=>sum+number(item.receivable_amount),0),reimbursementValue=number(reimbursement),talitaJorge=totalImile-totalDrops;return <><section className="card finance-preview"><label>Reembolso iMile deste período (apenas registro)<input type="number" step="0.01" value={reimbursement} onChange={event=>setReimbursement(event.target.value)}/></label><button className="secondary" onClick={()=>void saveReimbursement()}>Salvar reembolso</button><strong>Pagamento Talita e Jorge: {money(talitaJorge)}</strong></section><section className="finance-summary"><article className="metric"><span>Linhas em Fechamento</span><strong>{details.length}</strong></article><article className="metric red"><span>Linhas em Extravios</span><strong>{viewLosses.length}</strong></article><article className="metric"><span>Total líquido iMile</span><strong>{money(totalImile)}</strong></article><article className="metric"><span>Pagamento aos Drops</span><strong>{money(totalDrops)}</strong></article></section></>})()}<section className="card"><h2>Fechamento</h2><div className="table-wrap"><table><thead><tr><th>Período</th><th>Parceiro</th><th>Drop</th><th>Quantidade de pacotes</th><th>Total padrão</th><th>Valor acordado</th><th>Valor pago AGU bruto</th><th>Extravio</th><th>Total a receber do AGU</th><th>Relatório</th></tr></thead><tbody>{details.map(item=><tr key={item.id}><td>{item.period?.label}</td><td>{item.period?.partner}</td><td>{item.drop_name_snapshot}</td><td>{item.quantity_packages}</td><td>{money(item.standard_total)}</td><td>{money(item.agreed_value)}</td><td>{money(item.gross_amount)}</td><td>{money(item.loss_amount)}</td><td>{money(item.receivable_amount)}</td><td><button className="table-action" onClick={()=>reportFor(item)}>Gerar PDF</button></td></tr>)}</tbody></table></div></section><section className="card"><h2>Extravios</h2><div className="table-wrap"><table><thead><tr><th>Período</th><th>Parceiro</th><th>Drop</th><th>Waybill</th><th>Status</th><th>Valor</th><th>Observação</th><th>Ação</th></tr></thead><tbody>{viewLosses.map(item=><tr key={item.id}><td>{item.period_label}</td><td>{item.partner}</td><td>{item.drop_name_snapshot}</td><td>{item.waybill}</td><td>{item.status}</td><td>{money(item.amount)}</td><td>{item.observation}</td><td><button className="table-action" onClick={()=>void editLoss(item)}>Editar</button></td></tr>)}</tbody></table></div></section></>}
  </section>
}
