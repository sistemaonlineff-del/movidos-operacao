import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createHmac, randomUUID } from 'node:crypto'
import { canReviewDropRegistration, DROP_REGISTRATION_BUCKET, MAX_REQUEST_BYTES, validClientId, validateRegistration, type DropRegistration } from '../src/dropRegistrationShared.js'
import { registrationFiles, registrationHash, registrationImage } from '../src/dropRegistrationFiles.js'

class RegistrationError extends Error { constructor(public status: number,message: string) {super(message)} }
const fail = (status: number,message: string): never => {throw new RegistrationError(status,message)}

async function authorize(admin: SupabaseClient,req: VercelRequest) {
  const token=/^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization??''))?.[1]
  if (!token) return fail(401,'Entre novamente no sistema.')
  const auth=await admin.auth.getUser(token)
  if (auth.error || !auth.data.user) return fail(401,'Sessao invalida.')
  const profile=await admin.from('user_profiles').select('role,is_active').eq('id',auth.data.user.id).maybeSingle()
  const permissions=await admin.from('user_module_permissions').select('cadastros_create,cadastros_edit').eq('user_id',auth.data.user.id).maybeSingle()
  if (profile.error || permissions.error || !canReviewDropRegistration(profile.data,permissions.data??{})) return fail(403,'Sem permissao para revisar cadastros.')
  const actorId=auth.data.user.id
  const check=await admin.rpc('drop_registration_authorize',{actor_id:actorId})
  if (check.error) return fail(403,'Perfil inativo ou permissoes alteradas. Entre novamente.')
  return actorId
}

async function verifyPhotos(admin: SupabaseClient,record: DropRegistration) {
  for (const photo of record.photos) {
    const stored=await admin.storage.from(DROP_REGISTRATION_BUCKET).download(photo.path)
    if (stored.error || !stored.data) return fail(409,'Fotos incompletas. O envio permanece sem confirmacao; tente novamente com o mesmo protocolo e fotos.')
    const content=Buffer.from(await stored.data.arrayBuffer())
    if (content.length!==photo.size || registrationHash(content)!==photo.hash || registrationImage(content).type!==photo.type) return fail(409,'Foto armazenada divergente. Nao foi confirmado o recebimento.')
  }
}

async function submit(admin: SupabaseClient,req: VercelRequest,serviceKey: string) {
  const input=req.body
  if (!input || !validClientId(input.clientId) || input.consent!==true) return fail(400,'Protocolo e consentimento para tratamento dos dados sao obrigatorios.')
  const clientId=input.clientId.toLowerCase()
  let snapshot, files
  try {snapshot=validateRegistration(input.snapshot); files=registrationFiles(input.photos)} catch(error) {return fail(400,error instanceof Error?error.message:'Cadastro invalido.')}
  const digest=registrationHash(JSON.stringify([snapshot,files.map(file=>[file.digest,file.name,file.caption])]))
  const ip=String(req.headers['x-vercel-forwarded-for']??req.headers['x-forwarded-for']??'unknown').split(',')[0].trim()
  const ipKey=createHmac('sha256',serviceKey).update(`drop-registration|${new Date().toISOString().slice(0,10)}|${ip}`).digest('hex')
  const manifest=files.map(file=>({path:`submissions/${clientId}/${randomUUID()}.${file.extension}`,hash:file.digest,size:file.content.length,type:file.type,name:file.name,caption:file.caption}))
  const reservation=await admin.rpc('drop_registration_reserve',{client_id:clientId,digest,submission:snapshot,manifest,ip_key:ipKey})
  if (reservation.error) return fail(reservation.error.code==='23505'?409:503,reservation.error.code==='23505'?'Protocolo ja utilizado com outro conteudo. Retome o envio original ou inicie um novo cadastro.':'Nao foi possivel reservar o envio. Guarde o protocolo e tente novamente.')
  if (!reservation.data) return fail(429,'Limite diario atingido. Tente em outro dia ou contate a Movidos.')
  const record=reservation.data as DropRegistration
  if (record.status!=='uploading') return {status:'pending',protocol:clientId}
  try {
    for (const photo of record.photos) {
      const file=files.find(candidate=>candidate.digest===photo.hash)
      if (!file) return fail(409,'As fotos diferem do envio original.')
      await admin.storage.from(DROP_REGISTRATION_BUCKET).upload(photo.path,file.content,{contentType:photo.type,upsert:false})
    }
    await verifyPhotos(admin,record)
    const finished=await admin.rpc('drop_registration_finalize',{client_id:clientId,digest})
    if (finished.error || finished.data!==true) throw new Error('Confirmacao indisponivel')
  } catch {
    return {status:'uploading',protocol:clientId,error:'Envio incompleto ou sem confirmacao. Mantenha os mesmos dados e fotos e tente novamente; o protocolo foi preservado.'}
  }
  return {status:'pending',protocol:clientId}
}

export default async function handler(req: VercelRequest,res: VercelResponse) {
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff')
  if (!['GET','POST'].includes(req.method??'')) {res.setHeader('Allow','GET, POST');return res.status(405).json({error:'Metodo nao permitido.'})}
  try {
    if (req.method==='POST' && (Number(req.headers['content-length']??0)>MAX_REQUEST_BYTES || Buffer.byteLength(JSON.stringify(req.body??{}))>MAX_REQUEST_BYTES)) return fail(413,'Envio excede 4,5 MB. Reduza as fotos para 2 MB no total.')
    const url=process.env.SUPABASE_URL, serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !serviceKey) return fail(503,'Recebimento de cadastros ainda nao configurado.')
    const admin=createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}})
    if (req.method==='POST' && req.body?.mode==='submit-public') {
      const result=await submit(admin,req,serviceKey)
      return res.status(result.status==='uploading'?202:200).json(result)
    }
    const actorId=await authorize(admin,req)
    if (req.method==='GET') {
      const raw=String(req.query?.offset??'0')
      if (!/^\d{1,7}$/.test(raw)) return fail(400,'Pagina invalida.')
      const offset=Number(raw)
      const result=await admin.from('drop_registration_intake').select('id,status,snapshot,review_snapshot,photos,revision,approved_drop_id,created_at,review_note').order('created_at',{ascending:false}).order('id').range(offset,offset+49)
      if (result.error) return fail(503,'Lista indisponivel. Confira a migracao de pre-cadastros.')
      return res.status(200).json({submissions:result.data,nextOffset:result.data.length===50?offset+50:null})
    }
    const input=req.body??{}
    if (input.mode==='duplicates') {
      let snapshot
      try {snapshot=validateRegistration(input.snapshot)} catch(error) {return fail(400,(error as Error).message)}
      const result=await admin.rpc('drop_registration_duplicates',{submission:snapshot,actor_id:actorId})
      if (result.error) return fail(409,'Nao foi possivel conferir duplicados. Atualize as permissoes e tente novamente.')
      return res.status(200).json(result.data)
    }
    if (!validClientId(input.id)) return fail(400,'Pre-cadastro invalido.')
    const found=await admin.from('drop_registration_intake').select('*').eq('id',input.id).maybeSingle()
    if (found.error || !found.data) return fail(404,'Pre-cadastro nao encontrado.')
    const record=found.data as DropRegistration & {content_hash:string}
    if (input.mode==='download') {
      if (!Number.isInteger(input.photoIndex) || !record.photos[input.photoIndex]) return fail(400,'Foto invalida.')
      const photo=record.photos[input.photoIndex]
      const signed=await admin.storage.from(DROP_REGISTRATION_BUCKET).createSignedUrl(photo.path,60)
      if (signed.error || !signed.data?.signedUrl) return fail(503,'Foto indisponivel.')
      return res.status(200).json({url:signed.data.signedUrl})
    }
    if (input.mode==='recover') {
      await verifyPhotos(admin,record)
      const result=await admin.rpc('drop_registration_finalize',{client_id:record.id,digest:record.content_hash})
      if (result.error || result.data!==true) return fail(409,'Fotos sem confirmacao. O envio continua incompleto.')
      return res.status(200).json({status:record.status==='uploading'?'pending':record.status})
    }
    if (!['save','approve','reject'].includes(input.mode) || !Number.isInteger(input.revision)) return fail(400,'Revisao invalida.')
    let snapshot=null
    if (input.mode!=='reject') {
      try {snapshot=validateRegistration(input.snapshot)} catch(error) {return fail(400,(error as Error).message)}
    }
    if (input.mode==='approve' && record.status!=='approved') await verifyPhotos(admin,record)
    const reviewed=await admin.rpc('drop_registration_review',{
      submission_id:input.id,expected_revision:input.revision,action:input.mode,submission:snapshot,
      note:typeof input.note==='string'?input.note:null,partner_value:typeof input.partner==='string'&&input.partner?input.partner:null,
      duplicate_ack:typeof input.duplicateAck==='string'?input.duplicateAck:null,actor_id:actorId
    })
    if (reviewed.error) return fail(reviewed.error.code==='42501'?403:409,'Nao foi possivel concluir: confira duplicados, revisao, permissoes e fotos; atualize a lista antes de tentar novamente.')
    return res.status(200).json(reviewed.data)
  } catch(error) {
    return res.status(error instanceof RegistrationError?error.status:500).json({error:error instanceof RegistrationError?error.message:'Nao foi possivel concluir o pre-cadastro. Guarde seu protocolo e tente novamente.'})
  }
}