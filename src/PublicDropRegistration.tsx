import { useRef, useState, type FormEvent } from 'react'
import { Camera, CheckCircle2, LocateFixed, MapPin, Send, Trash2 } from 'lucide-react'
import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/600.css'
import { blankRegistration, BRAZIL_STATES, MIN_PHOTOS, MAX_PHOTOS, REGISTRATION_FIELDS, validClientId, validateRegistration, type RegistrationField, type RegistrationPhoto, type RegistrationValues } from './dropRegistrationShared'
import { checkPhotoTotal, dropRegistrationRequest, photoBytes, prepareRegistrationPhoto, useDropRegistrationViewport } from './dropRegistrationClient'
import './PublicDropRegistration.css'

export { DROP_REGISTRATION_PATH } from './dropRegistrationShared'
const requiredFields=new Set(['name','responsible','phone','address','address_number','municipality','state','postal_code'])
const fieldGroups: {title:string;fields:RegistrationField[]}[]=[
  {title:'Contato',fields:['name','responsible','phone','alternate_phone','email']},
  {title:'Endereco do Drop',fields:['postal_code','address','address_number','complement','neighborhood','municipality','state']},
  {title:'PIX',fields:['pix_key','pix_holder_name']},
  {title:'Dados legais',fields:['cpf','cnpj','legal_name','trade_name','state_registration']},
  {title:'Endereco da empresa',fields:['company_postal_code','company_address','company_address_number','company_complement','company_neighborhood','company_municipality','company_state']}
]

export function DropRegistrationFields({values,onChange,idPrefix='public-drop'}:{values:RegistrationValues;onChange:(field:keyof RegistrationValues,value:string)=>void;idPrefix?:string}) {
  return <>{fieldGroups.map(group=><section className="dr-field-section" key={group.title}>
    <h2>{group.title}</h2><div className="dr-fields">{group.fields.map(field=><label key={field} htmlFor={`${idPrefix}-${field}`} className={['address','company_address','legal_name','name'].includes(field)?'dr-wide':''}>
      <span>{REGISTRATION_FIELDS[field]}{requiredFields.has(field)?' *':''}</span>
      {field==='state'||field==='company_state'?<select id={`${idPrefix}-${field}`} value={values[field]} required={requiredFields.has(field)} onChange={event=>onChange(field,event.target.value)}><option value="">Selecione</option>{BRAZIL_STATES.map(state=><option key={state}>{state}</option>)}</select>:
        <input id={`${idPrefix}-${field}`} value={values[field]} required={requiredFields.has(field)} maxLength={200} type={field==='email'?'email':field==='phone'||field==='alternate_phone'?'tel':'text'} autoComplete={field==='email'?'email':field==='phone'?'tel':'off'} onChange={event=>onChange(field,event.target.value)}/>}
    </label>)}</div></section>)}
    <section className="dr-field-section"><h2>Localizacao</h2><p id={`${idPrefix}-location-help`}>Para encontrar os dados de latitude e longitude, procure o seu endereço no Google Maps e clique em cima do seu endereço que vai aparecer a latitude e longitude. Preencha corretamente para que você apareça no mapa.</p><div className="dr-fields dr-coordinates">{(['latitude','longitude'] as const).map(field=><label key={field} htmlFor={`${idPrefix}-${field}`}><span>{field==='latitude'?'Latitude':'Longitude'} *</span><input id={`${idPrefix}-${field}`} aria-describedby={`${idPrefix}-location-help`} type="number" step="any" required min={field==='latitude'?-35:-75} max={field==='latitude'?6:-32} value={values[field]} onChange={event=>onChange(field,event.target.value)}/></label>)}</div></section>
    <label className="dr-notes" htmlFor={`${idPrefix}-notes`}>Fale um pouco sobre você e suas experiências<textarea id={`${idPrefix}-notes`} value={values.notes} maxLength={2000} rows={3} onChange={event=>onChange('notes',event.target.value)}/></label>
  </>
}

function initialProtocol() {
  try {const value=sessionStorage.getItem('movidos-public-drop-protocol');if(validClientId(value))return value} catch {}
  return crypto.randomUUID()
}

export default function PublicDropRegistration() {
  const [values,setValues]=useState(blankRegistration),[photos,setPhotos]=useState<RegistrationPhoto[]>([])
  const [protocol,setProtocol]=useState(initialProtocol),[consent,setConsent]=useState(false)
  const [busy,setBusy]=useState(false),[preparing,setPreparing]=useState(false),[locating,setLocating]=useState(false)
  const [started,setStarted]=useState(false),[submitted,setSubmitted]=useState(false),[message,setMessage]=useState(''),[locationMessage,setLocationMessage]=useState('')
  const lock=useRef(false),fileInput=useRef<HTMLInputElement>(null),attempt=useRef<Record<string,unknown>|null>(null)
  useDropRegistrationViewport()
  const put=(field:keyof RegistrationValues,value:string)=>setValues(previous=>({...previous,[field]:value}))
  const locate=()=>{
    setLocationMessage('');setLocating(true)
    if(!navigator.geolocation){setLocationMessage('Localizacao indisponivel. Preencha latitude e longitude.');setLocating(false);return}
    navigator.geolocation.getCurrentPosition(position=>{
      const {latitude,longitude}=position.coords
      if(latitude < -35 || latitude > 6 || longitude < -75 || longitude > -32){setLocationMessage('Localizacao fora dos limites aceitos. Confira as coordenadas do Drop.');setLocating(false);return}
      setValues(previous=>({...previous,latitude:latitude.toFixed(7),longitude:longitude.toFixed(7)}));setLocating(false);setLocationMessage('Localizacao obtida. Confira se corresponde ao Drop.')
    },()=>{setLocating(false);setLocationMessage('Localizacao nao autorizada ou indisponivel. Preencha latitude e longitude.')},{enableHighAccuracy:true,timeout:10000,maximumAge:0})
  }
  const addPhotos=async(files:File[])=>{
    if(lock.current||preparing)return
    setMessage('');setPreparing(true)
    try {
      if(photos.length+files.length>MAX_PHOTOS)throw new Error('Envie no maximo cinco fotos.')
      const prepared=[]
      for(const file of files)prepared.push(await prepareRegistrationPhoto(file))
      const next=[...photos,...prepared];checkPhotoTotal(next);setPhotos(next)
    }catch(error){setMessage((error as Error).message)}finally{setPreparing(false);if(fileInput.current)fileInput.current.value=''}
  }
  const submit=async(event:FormEvent)=>{
    event.preventDefault()
    if(lock.current||preparing||locating)return
    setMessage('')
    try {
      if(!consent)throw new Error('Confirme o consentimento para enviar os dados.')
      if(photos.length<MIN_PHOTOS||photos.length>MAX_PHOTOS)throw new Error('Adicione de tres a cinco fotos do Drop, incluindo a fachada e seu espaco interno.')
      const snapshot=validateRegistration(values);checkPhotoTotal(photos)
      attempt.current??={mode:'submit-public',clientId:protocol,consent:true,snapshot,photos}
      try {sessionStorage.setItem('movidos-public-drop-protocol',protocol)} catch {}
      lock.current=true;setBusy(true);setStarted(true)
      const result=await dropRegistrationRequest(attempt.current)
      if(result.status!=='pending')throw new Error(result.error||'Recebimento sem confirmacao. Tente novamente com o mesmo protocolo.')
      setSubmitted(true)
    }catch(error){setMessage(error instanceof Error?error.message:'Conexao interrompida. Guarde o protocolo e tente novamente.')}finally{lock.current=false;setBusy(false)}
  }
  const reset=()=>{
    if(!submitted&&!window.confirm('O envio anterior pode ter sido recebido. Um novo protocolo pode criar outro pre-cadastro. Continuar?'))return
    const next=crypto.randomUUID();setProtocol(next);try{sessionStorage.setItem('movidos-public-drop-protocol',next)}catch{}
    attempt.current=null;setStarted(false);setSubmitted(false);setValues(blankRegistration());setPhotos([]);setConsent(false);setMessage('');setLocationMessage('')
  }
  return <main className="drop-registration dr-public">
    <header className="dr-header"><img src="/brand/movidos-wordmark.png" alt="Movidos"/><span>Cadastro de parceiros</span></header>
    <div className="dr-public-body"><div className="dr-title"><MapPin aria-hidden="true"/><div><h1>Pre-cadastro Drop</h1><p>Analise cadastral · Sem ativacao automatica</p></div></div>
      {submitted?<section className="dr-receipt" role="status"><CheckCircle2 size={32} aria-hidden="true"/><h2>Pre-cadastro recebido</h2><p>Aguardando revisao da Movidos. Este envio nao ativa uma operacao nem gera contrato ou pagamento.</p><label>Protocolo<input readOnly value={protocol}/></label><button type="button" onClick={reset}>Novo pre-cadastro</button></section>:
      <form onSubmit={submit}>
        <fieldset disabled={busy||started||preparing||locating}>
          <div className="dr-location-action"><button type="button" onClick={locate}><LocateFixed size={18} aria-hidden="true"/>{locating?'Localizando...':'Autorizar localizacao atual'}</button><span role="status">{locationMessage}</span></div>
          <DropRegistrationFields values={values} onChange={put}/>
          <section className="dr-field-section dr-photos"><div className="dr-section-heading"><h2>Fotos do Drop *</h2><span>{photos.length}/{MAX_PHOTOS} · {(photoBytes(photos)/1024/1024).toFixed(2)} / 2 MB</span></div>
            <p>Faça o upload de 3 a 5 fotos, incluindo a fachada e seu espaço interno.</p>
            <input ref={fileInput} className="dr-file-input" aria-label="Fotos do Drop" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={event=>void addPhotos(Array.from(event.target.files??[]))}/>
            <button type="button" disabled={photos.length>=MAX_PHOTOS} onClick={()=>fileInput.current?.click()}><Camera size={18} aria-hidden="true"/>{preparing?'Preparando fotos...':'Adicionar fotos'}</button>
            <div className="dr-gallery">{photos.map((photo,index)=><figure key={`${index}-${photo.fileName}`}><img src={`data:image/jpeg;base64,${photo.content}`} alt={photo.caption||`Foto ${index+1} do Drop`}/><figcaption><label>Legenda da foto {index+1}<input value={photo.caption} maxLength={200} onChange={event=>setPhotos(previous=>previous.map((item,position)=>position===index?{...item,caption:event.target.value}:item))}/></label><button type="button" className="dr-icon" title={`Remover foto ${index+1}`} aria-label={`Remover foto ${index+1}`} onClick={()=>setPhotos(previous=>previous.filter((_,position)=>position!==index))}><Trash2 size={18}/></button></figcaption></figure>)}</div>
          </section>
          <label className="dr-check"><input type="checkbox" checked={consent} required onChange={event=>setConsent(event.target.checked)}/><span>Autorizo o tratamento destes dados pessoais, de contato, localizacao e fotos para analise deste pre-cadastro pela Movidos. Confirmo que posso fornecer os dados e o PIX informado.</span></label>
        </fieldset>
        {message&&<p role="alert" className="dr-error">{message}</p>}
        {started&&<p className="dr-protocol">Protocolo: <strong>{protocol}</strong></p>}
        <footer className="dr-submit"><button className="dr-primary" type="submit" disabled={busy||preparing||locating}><Send size={18} aria-hidden="true"/>{busy?'Enviando...':started?'Repetir envio com mesmo protocolo':'Enviar pre-cadastro'}</button>{started&&<button type="button" disabled={busy} onClick={reset}>Novo protocolo</button>}</footer>
      </form>}
    </div>
  </main>
}