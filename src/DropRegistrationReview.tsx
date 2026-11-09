import { useEffect, useRef, useState } from 'react'
import { Check, ClipboardCheck, Copy, ExternalLink, Eye, Image, Link2, MessageCircle, RefreshCw, Save, Search, X } from 'lucide-react'
import { useAccess } from './access'
import { supabase } from './lib/supabase'
import { PARTNERS } from './dropOptions'
import { DropRegistrationFields } from './PublicDropRegistration'
import { dropRegistrationRequest } from './dropRegistrationClient'
import { canReviewDropRegistration, DROP_REGISTRATION_PATH, DROP_REGISTRATION_REVIEW_PATH, registrationValues, validateRegistration, type DropRegistration, type RegistrationValues } from './dropRegistrationShared'
import './DropRegistrationReview.css'

export { DROP_REGISTRATION_REVIEW_PATH } from './dropRegistrationShared'
type Duplicate={id:string;name:string;responsible:string|null;address:string|null;municipality:string|null;status:string;is_active:boolean}
type DuplicateResult={matches:Duplicate[];acknowledgment:string}
const statusLabels={uploading:'Fotos incompletas',pending:'Pendente',approved:'Aprovado · INTERESSADO',rejected:'Recusado'}

async function authenticatedRequest(input?:Record<string,unknown>,offset=0) {
  if(!supabase)throw new Error('Sessao indisponivel.')
  const session=await supabase.auth.getSession()
  if(session.error||!session.data.session?.access_token)throw new Error('Entre novamente no sistema.')
  return dropRegistrationRequest(input,session.data.session.access_token,offset)
}

export function DropRegistrationLinkActions({includeReviewLink=true}:{includeReviewLink?:boolean}={}) {
  const {profile,permissions}=useAccess()
  const [notice,setNotice]=useState('')
  if(!canReviewDropRegistration(profile,permissions))return null
  const url=new URL(DROP_REGISTRATION_PATH,window.location.origin).href
  const copy=async()=>{try{await navigator.clipboard.writeText(url);setNotice('Link copiado.')}catch{setNotice('Copia indisponivel. O link esta no campo abaixo.')}}
  return <div className="drop-registration dr-link-actions">
    <span><Link2 size={17} aria-hidden="true"/> Pre-cadastro publico</span>
    <button className="dr-icon" type="button" title="Copiar link de pre-cadastro" aria-label="Copiar link de pre-cadastro" onClick={()=>void copy()}><Copy size={18}/></button>
    <a className="dr-link-button dr-icon" href={url} target="_blank" rel="noreferrer" title="Abrir formulario publico" aria-label="Abrir formulario publico"><ExternalLink size={18}/></a>
    <a className="dr-link-button dr-icon" href={`https://wa.me/?text=${encodeURIComponent(url)}`} target="_blank" rel="noreferrer" title="Compartilhar link no WhatsApp" aria-label="Compartilhar link no WhatsApp"><MessageCircle size={18}/></a>
    {includeReviewLink&&<a className="dr-link-button dr-icon" href={DROP_REGISTRATION_REVIEW_PATH} title="Revisar pre-cadastros" aria-label="Revisar pre-cadastros"><ClipboardCheck size={18}/></a>}
    {notice&&<div className="dr-copy-notice" role="status"><span>{notice}</span><input aria-label="Link publico do Drop" value={url} readOnly/></div>}
  </div>
}

export default function DropRegistrationReview({onApproved,onOpenDrop}:{onApproved?:(dropId:string)=>void;onOpenDrop?:(dropId:string)=>void}={}) {
  const {profile,permissions,loading:accessLoading}=useAccess()
  const permitted=canReviewDropRegistration(profile,permissions)
  const [rows,setRows]=useState<DropRegistration[]>([]),[loading,setLoading]=useState(true),[failed,setFailed]=useState(false),[nextOffset,setNextOffset]=useState<number|null>(null)
  const [selected,setSelected]=useState<DropRegistration|null>(null),[values,setValues]=useState<RegistrationValues|null>(null),[partner,setPartner]=useState(''),[note,setNote]=useState('')
  const [status,setStatus]=useState('pending'),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[notice,setNotice]=useState('')
  const [query,setQuery]=useState('')
  const [duplicates,setDuplicates]=useState<DuplicateResult|null>(null),[acknowledged,setAcknowledged]=useState(false),[photoUrls,setPhotoUrls]=useState<string[]>([])
  const lock=useRef(false),generation=useRef(0),photoGeneration=useRef(0)
  const load=async(offset=0)=>{
    const current=++generation.current
    setLoading(true);setMessage('');setFailed(false)
    try {
      const result=await authenticatedRequest(undefined,offset)
      if(current!==generation.current)return
      setRows(previous=>offset?[...previous,...result.submissions]:result.submissions);setNextOffset(result.nextOffset)
    }catch(error){if(current===generation.current){setFailed(true);setRows([]);setMessage((error as Error).message)}}finally{if(current===generation.current)setLoading(false)}
  }
  useEffect(()=>{
    if(permitted)void load();else{setLoading(false);setRows([]);setSelected(null);setValues(null);setPhotoUrls([])}
    return ()=>{generation.current++;photoGeneration.current++}
  },[permitted])
  const select=(row:DropRegistration)=>{
    photoGeneration.current++;setPhotoUrls([]);setSelected(row);setValues(registrationValues(row.review_snapshot??row.snapshot));setPartner('');setNote(row.review_note??'');setDuplicates(null);setAcknowledged(false);setMessage('');setNotice('')
  }
  const put=(field:keyof RegistrationValues,value:string)=>{
    setValues(previous=>previous?{...previous,[field]:value}:null);setDuplicates(null);setAcknowledged(false)
  }
  const inspectDuplicates=async()=>{
    if(lock.current||!values)return
    lock.current=true;setBusy(true);setMessage('')
    try{const snapshot=validateRegistration(values);const result=await authenticatedRequest({mode:'duplicates',snapshot});setDuplicates(result);setAcknowledged(false)}catch(error){setMessage((error as Error).message)}finally{lock.current=false;setBusy(false)}
  }
  const photos=async()=>{
    if(lock.current||!selected)return
    lock.current=true;setBusy(true);setMessage('');const current=++photoGeneration.current
    try{
      const urls=[]
      for(let index=0;index<selected.photos.length;index++){const result=await authenticatedRequest({mode:'download',id:selected.id,photoIndex:index});urls.push(result.url)}
      if(current===photoGeneration.current)setPhotoUrls(urls)
    }catch(error){if(current===photoGeneration.current)setMessage((error as Error).message)}finally{lock.current=false;setBusy(false)}
  }
  const mutate=async(action:'save'|'approve'|'reject'|'recover')=>{
    if(lock.current||!selected||!values)return
    setMessage('');setNotice('')
    try {
      if(action==='approve'&&(!duplicates||(duplicates.matches.length>0&&!acknowledged)))throw new Error('Confira os possiveis duplicados e reconheca as correspondencias.')
      if(action==='reject'&&note.trim().length<8)throw new Error('Informe o motivo da recusa (8 caracteres).')
      const snapshot=action==='reject'||action==='recover'?undefined:validateRegistration(values)
      if(action==='approve'&&!window.confirm('Aprovar este pre-cadastro e criar um Drop INTERESSADO, sem iniciar operacao e sem datas operacionais?'))return
      if(action==='reject'&&!window.confirm('Recusar este pre-cadastro?'))return
      lock.current=true;setBusy(true)
      const result=await authenticatedRequest({mode:action,id:selected.id,revision:selected.revision,snapshot,note,partner,duplicateAck:acknowledged?duplicates?.acknowledgment:null})
      setSelected(null);setValues(null);setPhotoUrls([]);photoGeneration.current++
      await load()
      setNotice(action==='approve'?'Pre-cadastro aprovado. Drop criado como INTERESSADO; nenhuma operacao iniciada.':action==='reject'?'Pre-cadastro recusado.':action==='recover'?'Fotos confirmadas; pre-cadastro pendente.':'Revisao salva. Nenhum Drop criado.')
      if(result.dropId)onApproved?.(result.dropId)
    }catch(error){setMessage((error as Error).message)}finally{lock.current=false;setBusy(false)}
  }
  if(accessLoading)return <section className="drop-registration dr-review" role="status">Carregando permissoes...</section>
  if(!permitted)return <section className="drop-registration dr-review" role="alert"><h2>Acesso restrito</h2><p>Requer perfil ativo e permissao de criar e editar cadastros, ou administrador.</p></section>
  const term=query.trim().toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  const digits=term.replace(/\D/g,'')
  const filtered=rows.filter(row=>{
    if(status!=='all'&&row.status!==status)return false
    const snapshot=row.review_snapshot??row.snapshot
    const identity=[row.id,snapshot.name,snapshot.responsible,snapshot.municipality,snapshot.phone,snapshot.alternate_phone].join(' ').toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    return !term||identity.includes(term)||(/^[\d\s()+./-]+$/.test(term)&&digits.length>0&&[snapshot.phone,snapshot.alternate_phone].some(phone=>String(phone??'').replace(/\D/g,'').includes(digits)))
  })
  return <section className="drop-registration dr-review">
    <header className="dr-review-header"><div><h1>Pre-cadastros de Drop</h1><p>Recebimento e revisao</p></div><div className="dr-review-tools"><DropRegistrationLinkActions includeReviewLink={false}/><button type="button" className="dr-icon" disabled={busy||loading} onClick={()=>{setSelected(null);setValues(null);setPhotoUrls([]);void load()}} title="Atualizar pre-cadastros" aria-label="Atualizar pre-cadastros"><RefreshCw size={18}/></button></div></header>
    <div className="dr-review-filter"><label>Status<select aria-label="Status" value={status} disabled={busy} onChange={event=>{setStatus(event.target.value);setSelected(null);setValues(null);setPhotoUrls([]);photoGeneration.current++}}><option value="all">Todos</option>{Object.entries(statusLabels).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label><label>Buscar nos pre-cadastros carregados<input type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Nome, protocolo ou telefone"/></label><span>{filtered.length} de {rows.length} carregados</span></div>
    {message&&<p role="alert" className="dr-error">{message}</p>}{notice&&<p role="status" className="dr-notice">{notice}</p>}
    {loading&&<p role="status">Carregando pre-cadastros...</p>}
    {!loading&&!failed&&!filtered.length&&<p className="dr-empty">Nenhum pre-cadastro neste status.</p>}
    <div className="dr-table-scroll"><table><thead><tr><th>Drop / responsavel</th><th>Cidade</th><th>Recebido</th><th>Status</th><th>Revisao</th></tr></thead><tbody>{filtered.map(row=><tr key={row.id} aria-selected={selected?.id===row.id}><td><strong>{row.snapshot.name}</strong><small>{row.snapshot.responsible}</small></td><td>{row.snapshot.municipality} / {row.snapshot.state}</td><td>{new Date(row.created_at).toLocaleString('pt-BR')}</td><td><span className={`dr-status dr-status-${row.status}`}>{statusLabels[row.status]}</span></td><td><button type="button" className="dr-icon" disabled={busy} title={`Revisar ${row.snapshot.name}`} aria-label={`Revisar ${row.snapshot.name}`} onClick={()=>select(row)}><Eye size={18}/></button></td></tr>)}</tbody></table></div>
    {nextOffset!==null&&<button type="button" disabled={loading||busy} onClick={()=>void load(nextOffset)}>Carregar mais</button>}
    {selected&&values&&<section className="dr-review-editor" aria-label="Revisao do pre-cadastro"><div className="dr-section-heading"><div><h2>{selected.snapshot.name}</h2><span className="dr-protocol">Protocolo {selected.id}</span></div><button type="button" className="dr-icon" disabled={busy} title="Fechar revisao" aria-label="Fechar revisao" onClick={()=>{setSelected(null);setValues(null);setPhotoUrls([]);photoGeneration.current++}}><X size={18}/></button></div>
      <div className="dr-photo-heading"><span>{selected.photos.length} foto(s)</span><button type="button" disabled={busy} onClick={()=>void photos()}><Image size={18} aria-hidden="true"/>Ver fotos privadas</button></div>
      <div className="dr-gallery">{photoUrls.map((url,index)=><figure key={`${selected.id}-${index}`}><img src={url} alt={selected.photos[index].caption||`Foto ${index+1} do Drop`} onError={()=>setMessage('Foto indisponivel ou link expirado. Abra as fotos novamente.')}/><figcaption>{selected.photos[index].caption||`Foto ${index+1}`}</figcaption></figure>)}</div>
      <fieldset disabled={busy||selected.status!=='pending'}><DropRegistrationFields values={values} onChange={put} idPrefix="review-drop"/>
        <div className="dr-review-extra"><label>Parceiro<select value={partner} onChange={event=>setPartner(event.target.value)}><option value="">Sem parceiro atribuido</option>{PARTNERS.map(value=><option key={value}>{value}</option>)}</select></label><label>Observacao da revisao / motivo da recusa<textarea value={note} maxLength={2000} rows={3} onChange={event=>setNote(event.target.value)}/></label></div>
      </fieldset>
      {selected.status==='pending'&&<><div className="dr-duplicate-check"><button type="button" disabled={busy} onClick={()=>void inspectDuplicates()}><Search size={18} aria-hidden="true"/>Conferir duplicados</button>{duplicates&&<span role="status">{duplicates.matches.length?`${duplicates.matches.length} possivel(is) correspondencia(s)`:'Nenhuma correspondencia encontrada'}</span>}</div>
        {duplicates&&duplicates.matches.length>0&&<div className="dr-duplicates"><ul>{duplicates.matches.map(match=><li key={match.id}><strong>{match.name}</strong> · {match.responsible||'Sem responsavel'} · {match.address} · {match.municipality} · {match.status} · {match.is_active?'ativo':'inativo'}</li>)}</ul><label className="dr-check"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event=>setAcknowledged(event.target.checked)}/><span>Conferi as correspondencias e confirmo que este e um cadastro distinto.</span></label></div>}
        <footer className="dr-submit"><button type="button" disabled={busy||failed} onClick={()=>void mutate('save')}><Save size={18} aria-hidden="true"/>Salvar revisao</button><button type="button" className="dr-primary" disabled={busy||failed||!duplicates||(duplicates.matches.length>0&&!acknowledged)} onClick={()=>void mutate('approve')}><Check size={18} aria-hidden="true"/>Aprovar sem ativar</button><button type="button" disabled={busy||failed||note.trim().length<8} onClick={()=>void mutate('reject')}><X size={18} aria-hidden="true"/>Recusar</button></footer>
      </>}
      {selected.status==='uploading'&&<div className="dr-incomplete"><p>Fotos incompletas. A aprovacao esta bloqueada.</p><button type="button" disabled={busy} onClick={()=>void mutate('recover')}><RefreshCw size={18} aria-hidden="true"/>Conferir armazenamento</button></div>}
      {selected.approved_drop_id&&<div className="dr-approved"><p>Drop INTERESSADO: {selected.approved_drop_id}</p>{onOpenDrop&&<button type="button" onClick={()=>onOpenDrop(selected.approved_drop_id!)}><ExternalLink size={18} aria-hidden="true"/>Abrir cadastro</button>}</div>}
    </section>}
  </section>
}