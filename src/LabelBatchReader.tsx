import { ChangeEvent, useEffect, useRef, useState } from "react";
import { supabase } from "./lib/supabase";
import { extractionQuery, labelDeliveryAddress, parseLabelExtraction } from "./labelExtraction";
import { findLabelMatches } from "./labelMatching";
import type { LabelBase } from "./labelMatching";

type Save = { baseId:string; scanKey:string; driverId:string; packageAddress:string; addressConfirmed:boolean };
type Result = { name:string; state:"aguardando"|"lendo"|"concluido"|"erro"; result?:string; error?:string; save?:Save; address?:string };
const MAX_EDGE=1600;
async function imageData(file:File){ const url=URL.createObjectURL(file); try { const image=new Image(); image.src=url; await image.decode(); const scale=Math.min(1,MAX_EDGE/Math.max(image.width,image.height)); const canvas=document.createElement("canvas"); canvas.width=Math.round(image.width*scale); canvas.height=Math.round(image.height*scale); canvas.getContext("2d")!.drawImage(image,0,0,canvas.width,canvas.height); return canvas.toDataURL("image/jpeg",.75) } finally { URL.revokeObjectURL(url) } }

export default function LabelBatchReader({base,driverId,onSaved}:{base:LabelBase;driverId:string;onSaved:()=>void}) {
 const [rows,setRows]=useState<Result[]>([]),[running,setRunning]=useState(false);
 const alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
 const save=async(payload:Save)=>{
  const {data}=await supabase!.auth.getSession();
  const response=await fetch('/api/label-volume',{method:'POST',headers:{Authorization:`Bearer ${data.session?.access_token??''}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'Volume nao salvo. Tente novamente.');
  if(alive.current)onSaved();
 };
 const retry=async(index:number,payload:Save)=>{
  setRunning(true);
  try{await save(payload);if(alive.current)setRows(items=>items.map((row,position)=>position===index?{...row,state:'concluido',result:'Salvo na lista do motorista',save:undefined}:row))}
  catch(error){if(alive.current)setRows(items=>items.map((row,position)=>position===index?{...row,state:'erro',error:(error as Error).message}:row))}
  finally{if(alive.current)setRunning(false)}
 };
 const choose=async(event:ChangeEvent<HTMLInputElement>)=>{
  const files=Array.from(event.target.files??[]).slice(0,20),selectedDriver=driverId;event.target.value='';if(!files.length||running||!selectedDriver)return;
  setRows(files.map(file=>({name:file.name,state:'aguardando'})));setRunning(true);
  let index=0;
  const worker=async()=>{while(index<files.length&&alive.current){
   const current=index++,file=files[current],scanKey=crypto.randomUUID();
   setRows(items=>items.map((row,position)=>position===current?{...row,state:'lendo'}:row));
   try{
    const {data}=await supabase!.auth.getSession(),image=await imageData(file);
    const response=await fetch('/api/label-read',{method:'POST',headers:{Authorization:`Bearer ${data.session?.access_token??''}`,'Content-Type':'application/json'},body:JSON.stringify({image})});
    const payload=await response.json();if(!response.ok)throw new Error(payload.error||'Falha na leitura.');
    const extraction=parseLabelExtraction(payload.extraction),address=extractionQuery(extraction),matches=findLabelMatches(address,base.records);
    const safe=matches.length===1&&matches[0].streetMatch&&!matches[0].warnings.some(warning=>/nome aproximado|bairro divergente|rua não confirmada|cep lido é diferente/i.test(warning));
    if(!safe){if(alive.current)setRows(items=>items.map((row,position)=>position===current?{...row,state:'concluido',address,result:'Nao salvo: confira esta foto individualmente no leitor.'}:row));continue}
    const record:Save={baseId:String(matches[0].record.id),scanKey,driverId:selectedDriver,...labelDeliveryAddress(extraction)};
    if(alive.current)setRows(items=>items.map((row,position)=>position===current?{...row,save:record,address}:row));
    await save(record);
    if(alive.current)setRows(items=>items.map((row,position)=>position===current?{...row,state:'concluido',result:'Salvo na lista do motorista',save:undefined}:row));
   }catch(error){if(alive.current)setRows(items=>items.map((row,position)=>position===current?{...row,state:'erro',error:(error as Error).message}:row))}
  }};
  await Promise.all(Array.from({length:Math.min(3,files.length)},worker));if(alive.current)setRunning(false);
 };
 return <section className="card label-batch"><h3>Leitura em massa</h3><p>Selecione até 20 fotos. O sistema começa a processar cada etiqueta assim que ela entra na fila, em até 3 leituras simultâneas.</p><label className={`label-file ${running?'disabled':''}`}>Selecionar fotos<input aria-label="Selecionar fotos em massa" type="file" accept="image/jpeg,image/png,image/webp,image/bmp" multiple disabled={running||!driverId} onChange={event=>void choose(event)}/></label>{rows.length>0&&<ol className="label-batch-list">{rows.map((row,index)=><li key={`${row.name}-${index}`}><strong>{row.name}</strong><span className={`batch-${row.state}`}>{row.state==='aguardando'?'Na fila':row.state==='lendo'?'Lendo…':row.state==='concluido'?row.result:row.error}</span>{row.address&&<span>{row.address}</span>}{row.state==='erro'&&row.save&&<button type="button" disabled={running} onClick={()=>void retry(index,row.save!)}>Repetir gravacao sem duplicar</button>}</li>)}</ol>}</section>
}
