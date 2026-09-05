/* Recria a base de Views financeiras a partir do Pasta1.xlsx.
   Requer SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY somente em memória. */
import fs from 'node:fs/promises'
import * as XLSX from 'xlsx'

const baseUrl=(process.env.SUPABASE_URL??'').replace(/\/$/,'')
const secret=process.env.SUPABASE_SERVICE_ROLE_KEY??''
if(!baseUrl||!secret)throw new Error('Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nesta sessão.')
const headers={apikey:secret,Authorization:`Bearer ${secret}`,'Content-Type':'application/json'}
const text=value=>String(value??'').trim()
const value=value=>{if(typeof value==='number')return value;const raw=text(value);return Number(raw.includes(',')?raw.replace(/\./g,'').replace(',','.'):raw)||0}
const key=value=>text(value).toLocaleUpperCase('pt-BR')
const request=async(path,options={})=>{
  const response=await fetch(`${baseUrl}/rest/v1/${path}`,{...options,headers:{...headers,...options.headers}})
  if(!response.ok)throw new Error(`${options.method??'GET'} ${path}: ${response.status} ${await response.text()}`)
  return response.status===204?null:response.json()
}
const insert=async(table,rows,returning=false)=>request(table,{method:'POST',headers:{Prefer:returning?'return=representation':'return=minimal'},body:JSON.stringify(rows)})
const update=async(path,body)=>request(path,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify(body)})
const remove=async(table)=>request(`${table}?id=not.is.null`,{method:'DELETE',headers:{Prefer:'return=minimal'}})
const chunks=(rows,size=400)=>Array.from({length:Math.ceil(rows.length/size)},(_,index)=>rows.slice(index*size,index*size+size))

const source=process.argv[2]??'Pasta1.xlsx'
await fs.access(source)
const workbook=XLSX.readFile(source)
const sheet=workbook.Sheets.Planilha1
if(!sheet)throw new Error('O arquivo histórico precisa conter a aba Planilha1.')
const raw=XLSX.utils.sheet_to_json(sheet,{defval:''})
const required=['PERÍODO','DROP','PARCEIRO','TOTAL PACOTE','VALOR ACORDADO']
if(!raw.length||!required.every(column=>Object.hasOwn(raw[0],column)))throw new Error('As colunas do Pasta1.xlsx não correspondem ao modelo histórico.')
const periods=[]
const byPeriod=new Map()
const lastAgreed=new Map()
for(const row of raw){
  const label=text(row['PERÍODO']),drop=text(row.DROP)
  if(!label||!drop)continue
  const agreed=value(row['VALOR ACORDADO'])||lastAgreed.get(key(drop))||0
  if(agreed>0)lastAgreed.set(key(drop),agreed)
  const item={label,drop,partner:text(row.PARCEIRO)||'SEM PARCEIRO',quantity:Math.max(0,Math.trunc(value(row['TOTAL PACOTE']))),agreed}
  if(!byPeriod.has(label)){byPeriod.set(label,[]);periods.push(label)}
  byPeriod.get(label).push(item)
}

// Esta sequência elimina somente os dados financeiros que alimentam as Views.
await remove('loss_events')
await remove('financial_drop_items')
await remove('financial_periods')
await remove('financial_views')

for(const label of periods){
  const rows=byPeriod.get(label)
  const [view]=await insert('financial_views',[{title:label,source_file_name:'Pasta1.xlsx',source_rows:rows.length,import_status:'rascunho',notes:'Histórico geral importado do Pasta1.xlsx'}],true)
  const groups=[...new Map(rows.map(row=>[row.partner,{label,partner:row.partner,financial_view_id:view.id,status:'aberto'}])).values()]
  const financialPeriods=await insert('financial_periods',groups,true)
  const periodId=new Map(financialPeriods.map(row=>[row.partner,row.id]))
  for(const part of chunks(rows))await insert('financial_drop_items',part.map(row=>({financial_period_id:periodId.get(row.partner),drop_name_snapshot:row.drop,quantity_packages:row.quantity,unit_value:row.agreed,reimbursement:0})))
  await update(`financial_views?id=eq.${view.id}`,{import_status:'importado'})
  console.log(`${label}: ${rows.length} linhas`)
}
console.log(`Histórico concluído: ${periods.length} Views e ${raw.length} linhas de Fechamento.`)
