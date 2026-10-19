import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { buildDetails, financialPartner, key } from '../../src/financialData.js'
import { PARTNERS } from '../../src/dropOptions.js'

const bucket = 'financial-invoices'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
class InvoiceError extends Error { constructor(public status: number, message: string) { super(message) } }

export function intakeFields(input: Record<string, unknown>) {
  const fields = { drop_name: String(input.dropName ?? '').trim(), responsible: String(input.responsible ?? '').trim(), period_label: String(input.period ?? '').trim(), partner: String(input.partner ?? ''), reference_cnpj: String(input.referenceCnpj ?? '') }
  if (!fields.drop_name || fields.drop_name.length > 160 || !fields.responsible || fields.responsible.length > 160 || !fields.period_label || fields.period_label.length > 120 || !PARTNERS.includes(fields.partner) || !['MOVIDOS','BELLY','JOTA EXPRESS'].includes(fields.reference_cnpj)) throw new InvoiceError(400, 'Preencha DROP, responsável, período, parceiro e empresa válidos.')
  return fields
}

async function sharedIntake(admin: SupabaseClient, req: VercelRequest, serviceKey: string) {
  const input = req.body ?? {}
  if (!uuid.test(input.clientUploadId ?? '')) throw new InvoiceError(400, 'Identificador de envio inválido.')
  const fields = intakeFields(input)
  const file = invoiceFile(input)
  const ip = String(req.headers['x-vercel-forwarded-for'] ?? req.headers['x-forwarded-for'] ?? 'unknown').split(',')[0].trim()
  const bucketKey = createHmac('sha256', serviceKey).update(`${new Date().toISOString().slice(0,10)}|${ip}`).digest('hex')
  const admitted = await admin.rpc('reserve_invoice_intake', { bucket_key: bucketKey })
  if (admitted.error) throw new InvoiceError(503, 'Recebimento indisponível. Consulte o financeiro.')
  if (admitted.data !== true) throw new InvoiceError(429, 'Limite de envios atingido. Consulte o financeiro.')
  const submissionKey = hash(JSON.stringify([key(fields.drop_name), key(fields.responsible), key(fields.period_label), fields.partner, fields.reference_cnpj, file.digest]))
  const previous = await admin.from('financial_invoice_intake').select('*').eq('submission_key', submissionKey).maybeSingle()
  if (previous.error) throw new InvoiceError(503, 'Não foi possível conferir o envio.')
  let record = previous.data
  if (record?.status === 'pending' || record?.status === 'approved') return { status: 'pending', protocol: record.id }
  if (!record) {
    const id = input.clientUploadId
    const reserved = await admin.from('financial_invoice_intake').insert({ id, submission_key: submissionKey, ...fields, file_name: file.filename, storage_path: `intake/${id}/${randomUUID()}.${file.extension}`, content_hash: file.digest, size_bytes: file.content.length, content_type: file.type, status: 'uploading' }).select('*').single()
    if (reserved.error || !reserved.data) throw new InvoiceError(409, 'Envio já iniciado ou não confirmado. Confira com o financeiro antes de repetir.')
    record = reserved.data
  }
  const stored = await admin.storage.from(bucket).upload(record.storage_path, file.content, { contentType: file.type, upsert: false })
  if (stored.error) {
    const existing = await admin.storage.from(bucket).download(record.storage_path)
    if (existing.error || !existing.data || hash(Buffer.from(await existing.data.arrayBuffer())) !== file.digest) throw new InvoiceError(503, 'Armazenamento sem confirmação. Guarde o protocolo e consulte o financeiro.')
  }
  const finished = await admin.from('financial_invoice_intake').update({ status: 'pending' }).eq('id', record.id).eq('status', 'uploading').select('id').maybeSingle()
  if (finished.error || !finished.data) throw new InvoiceError(503, 'Arquivo sem confirmação. Guarde o protocolo e consulte o financeiro.')
  return { status: 'pending', protocol: record.id }
}

async function intakeReview(admin: SupabaseClient, input: Record<string, any>, userId: string) {
  if (!uuid.test(input.intakeId ?? '')) throw new InvoiceError(400, 'Envio inválido.')
  const stored = await admin.from('financial_invoice_intake').select('*').eq('id', input.intakeId).maybeSingle()
  if (stored.error || !stored.data) throw new InvoiceError(404, 'Envio não encontrado.')
  const record = stored.data
  if (input.mode === 'intake-download') {
    const signed = await admin.storage.from(bucket).createSignedUrl(record.storage_path, 60, { download: record.file_name })
    if (signed.error || !signed.data?.signedUrl) throw new InvoiceError(503, 'Não foi possível baixar o arquivo.')
    return { url: signed.data.signedUrl }
  }
  if (record.status === 'approved') throw new InvoiceError(409, 'Este envio já foi vinculado. Atualize a tela.')
  if (!uuid.test(input.periodId ?? '') || !uuid.test(input.dropId ?? '')) throw new InvoiceError(400, 'Selecione o pagamento do fechamento.')
  const period = await activePeriod(admin, input.periodId)
  const sources: Record<string, any[]> = {}
  for (const table of ['financial_drop_items','financial_payment_history']) {
    const rows: any[] = []
    for (let offset=0;;offset+=1000) {
      const result=await admin.from(table).select('*').eq('financial_period_id',period.id).eq('is_active',true).order('id').range(offset,offset+999)
      if(result.error)throw new InvoiceError(503,'Não foi possível conferir os pagamentos.')
      rows.push(...result.data);if(result.data.length<1000)break
    }
    sources[table]=rows
  }
  const details=buildDetails(sources.financial_payment_history,sources.financial_drop_items,[],[period])
  const matches=details.filter(row=>row.dropId===input.dropId&&row.referenceCnpj===(period.reference_cnpj||'MOVIDOS'))
  if(!matches.length)throw new InvoiceError(400,'O cadastro não está vinculado a este fechamento. Revise o financeiro.')
  const file=await admin.storage.from(bucket).download(record.storage_path)
  if(file.error||!file.data)throw new InvoiceError(409,'Arquivo não localizado; recebimento não confirmado.')
  const content=Buffer.from(await file.data.arrayBuffer())
  if(content.length!==record.size_bytes||hash(content)!==record.content_hash)throw new InvoiceError(409,'Arquivo divergente; recebimento não confirmado.')
  const result=await admin.from('financial_invoice_intake').update({status:'approved',financial_period_id:period.id,drop_id:input.dropId,reviewed_by:userId,reviewed_at:new Date().toISOString()}).eq('id',record.id).eq('status',record.status).select('id').maybeSingle()
  if(result.error||!result.data)throw new InvoiceError(409,'O envio mudou. Atualize antes de conferir novamente.')
  return {status:'approved'}
}

export function invoiceFile(input: Record<string, unknown>) {
  if (typeof input.content !== 'string' || input.content.length > 4194304 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.content)) throw new InvoiceError(400, 'Envie PDF ou XML de até 3 MB.')
  const content = Buffer.from(input.content, 'base64')
  if (!content.length || content.length > 3145728) throw new InvoiceError(400, 'Arquivo vazio ou maior que 3 MB.')
  const filename = String(input.fileName ?? '').replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').slice(0, 150)
  let type = '', extension = ''
  if (/\.pdf$/i.test(filename) && content.subarray(0, 5).toString() === '%PDF-' && content.subarray(-1024).includes(Buffer.from('%%EOF'))) { type = 'application/pdf'; extension = 'pdf' }
  if (/\.xml$/i.test(filename)) {
    const xml = content.toString('utf8')
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new InvoiceError(400, 'XML inválido ou com entidades não permitidas.')
    const parsed = new XMLParser({ processEntities: false, removeNSPrefix: true }).parse(xml)
    if (!parsed.NFe && !parsed.nfeProc?.NFe && !parsed.CompNfse && !parsed.Nfse) throw new InvoiceError(400, 'XML não reconhecido como NF-e ou NFS-e.')
    type = 'application/xml'; extension = 'xml'
  }
  if (!type) throw new InvoiceError(400, 'O conteúdo não corresponde a um PDF ou XML de nota fiscal.')
  return { content, filename, type, extension, digest: hash(content) }
}

async function authorize(admin: SupabaseClient, req: VercelRequest, manage: boolean) {
  const token = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1]
  if (!token) throw new InvoiceError(401, 'Entre novamente no sistema.')
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data.user) throw new InvoiceError(401, 'Sessão inválida.')
  const profile = await admin.from('user_profiles').select('role,is_active').eq('id', data.user.id).maybeSingle()
  if (profile.error || profile.data?.is_active !== true) throw new InvoiceError(403, 'Usuário sem acesso.')
  if (profile.data.role !== 'admin') {
    const permissions = await admin.from('user_module_permissions').select('financeiro_view,financeiro_manage').eq('user_id', data.user.id).maybeSingle()
    if (permissions.error || !(permissions.data?.financeiro_manage === true || (!manage && permissions.data?.financeiro_view === true))) throw new InvoiceError(403, 'Sem permissão financeira.')
  }
  return data.user.id
}

async function activePeriod(admin: SupabaseClient, id: string) {
  const result = await admin.from('financial_periods').select('*').eq('id', id).eq('is_active', true).maybeSingle()
  if (result.error) throw new InvoiceError(503, 'Não foi possível consultar o fechamento.')
  if (!result.data) throw new InvoiceError(410, 'Fechamento indisponível.')
  if (result.data.financial_view_id) {
    const view = await admin.from('financial_views').select('id').eq('id', result.data.financial_view_id).eq('is_active', true).maybeSingle()
    if (view.error) throw new InvoiceError(503, 'Não foi possível consultar a View.')
    if (!view.data) throw new InvoiceError(410, 'Fechamento indisponível.')
  }
  return result.data
}

async function publicRequest(admin: SupabaseClient, token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new InvoiceError(404, 'Link inválido.')
  const result = await admin.from('financial_invoice_requests').select('*').eq('token_hash', hash(token)).maybeSingle()
  if (result.error) throw new InvoiceError(503, 'Não foi possível consultar a solicitação.')
  const request = result.data
  if (!request || request.revoked_at || Date.parse(request.expires_at) <= Date.now()) throw new InvoiceError(410, 'Link expirado ou revogado. Solicite um novo ao financeiro.')
  const period = await activePeriod(admin, request.financial_period_id)
  if (request.period_label !== period.label || request.partner !== financialPartner(period) || request.reference_cnpj !== (period.reference_cnpj || 'MOVIDOS')) throw new InvoiceError(410, 'O fechamento foi alterado. Solicite um novo link.')
  return request
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  if (!['GET', 'POST'].includes(req.method ?? '')) return res.status(405).json({ error: 'Método não permitido.' })
  try {
    const url = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !serviceKey) throw new InvoiceError(503, 'Serviço de notas fiscais não configurado.')
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
    if (req.method === 'POST' && req.body?.mode === 'submit-public') return res.status(200).json(await sharedIntake(admin, req, serviceKey))
    const token = req.headers['x-invoice-token']
    if (typeof token === 'string') {
      const request = await publicRequest(admin, token)
      if (req.method === 'GET') {
        const files = await admin.from('financial_invoice_files').select('file_name,received_at').eq('request_id', request.id).eq('status', 'received').order('received_at')
        if (files.error) throw new InvoiceError(503, 'Não foi possível consultar os recebimentos.')
        return res.status(200).json({ drop: request.drop_name, period: request.period_label, partner: request.partner, referenceCnpj: request.reference_cnpj, expiresAt: request.expires_at, files: files.data })
      }
      if (req.body?.mode !== 'upload' || !uuid.test(req.body.clientUploadId ?? '')) throw new InvoiceError(400, 'Solicitação inválida.')
      const file = invoiceFile(req.body)
      const fileId = randomUUID()
      const reserved = await admin.from('financial_invoice_files').insert({ id: fileId, request_id: request.id, client_upload_id: req.body.clientUploadId, file_name: file.filename, storage_path: `${request.id}/${fileId}.${file.extension}`, content_hash: file.digest, size_bytes: file.content.length, content_type: file.type, status: 'uploading' }).select('*').single()
      let record = reserved.data
      if (reserved.error?.code === '23505') {
        const previous = await admin.from('financial_invoice_files').select('*').eq('request_id', request.id).eq('content_hash', file.digest).maybeSingle()
        if (previous.error || !previous.data) throw new InvoiceError(409, 'Identificador de envio já utilizado. Confira os recebimentos.')
        if (previous.data.status === 'received') return res.status(200).json({ status: 'received', duplicate: true })
        if (previous.data.status !== 'failed') throw new InvoiceError(409, 'Envio em andamento ou sem confirmação. Confira com o financeiro antes de repetir.')
        const retry = await admin.from('financial_invoice_files').update({ status: 'uploading' }).eq('id', previous.data.id).eq('status', 'failed').select('*').single()
        if (retry.error || !retry.data) throw new InvoiceError(409, 'Há outro envio em andamento.')
        record = retry.data
      } else if (reserved.error) throw new InvoiceError(409, 'Não foi possível reservar o arquivo. Confira o link e o limite de 20 arquivos.')
      if (!record) throw new InvoiceError(503, 'Não foi possível confirmar a reserva do arquivo.')
      try {
        const stored = await admin.storage.from(bucket).upload(record.storage_path, file.content, { contentType: file.type, upsert: false })
        if (stored.error) {
          const existing = await admin.storage.from(bucket).download(record.storage_path)
          if (existing.error || !existing.data || hash(Buffer.from(await existing.data.arrayBuffer())) !== file.digest) throw new Error('Storage failure')
        }
      } catch {
        await admin.from('financial_invoice_files').update({ status: 'failed' }).eq('id', record.id)
        throw new InvoiceError(503, 'O armazenamento não confirmou o arquivo. Os dados anteriores foram preservados; tente novamente com o mesmo arquivo.')
      }
      const finished = await admin.from('financial_invoice_files').update({ status: 'received', received_at: new Date().toISOString() }).eq('id', record.id).select('id').single()
      if (finished.error || !finished.data) return res.status(202).json({ status: 'pending', error: 'Arquivo armazenado, mas o registro não foi confirmado. Consulte o financeiro antes de repetir.' })
      return res.status(200).json({ status: 'received', duplicate: false })
    }
    const input = req.body ?? {}
    const userId = await authorize(admin, req, req.method === 'POST' && !['download','intake-download'].includes(input.mode))
    if (req.method === 'POST' && ['intake-download','intake-approve'].includes(input.mode)) return res.status(200).json(await intakeReview(admin,input,userId))
    if (req.method === 'GET') {
      const rows: unknown[] = []
      for (let offset = 0; ; offset += 1000) {
        const result = await admin.from('financial_invoice_requests').select('id,financial_period_id,drop_id,drop_name,period_label,partner,reference_cnpj,expires_at,revoked_at,financial_invoice_files(id,file_name,status,received_at)').order('created_at', { ascending: false }).range(offset, offset + 999)
        if (result.error) throw new InvoiceError(503, 'A estrutura de notas fiscais está indisponível. Confira a migração no Supabase.')
        rows.push(...result.data); if (result.data.length < 1000) break
      }
      const submissions: unknown[]=[]
      for(let offset=0;;offset+=1000){
        const result=await admin.from('financial_invoice_intake').select('id,drop_name,responsible,period_label,partner,reference_cnpj,file_name,status,financial_period_id,drop_id,created_at').order('created_at',{ascending:false}).range(offset,offset+999)
        if(result.error)throw new InvoiceError(503,'Confira a migração 20261018120000_shared_invoice_intake.sql no Supabase.')
        submissions.push(...result.data);if(result.data.length<1000)break
      }
      return res.status(200).json({ requests: rows, submissions })
    }
    if (input.mode === 'create') {
      if (!uuid.test(input.dropId ?? '') || !uuid.test(input.periodId ?? '')) throw new InvoiceError(400, 'DROP ou período inválido.')
      const period = await activePeriod(admin, input.periodId)
      const drop = await admin.from('drops').select('id,name,partner').eq('id', input.dropId).maybeSingle()
      if (drop.error || !drop.data) throw new InvoiceError(400, 'DROP não encontrado.')
      if (financialPartner(drop.data) !== financialPartner(period)) throw new InvoiceError(400, 'O parceiro do DROP não corresponde ao fechamento.')
      const membership = await Promise.all(['financial_drop_items', 'financial_payment_history'].map(table => admin.from(table).select('id').eq('financial_period_id', period.id).eq('drop_name_snapshot', drop.data.name).eq('is_active', true).limit(1)))
      if (membership.some(result => result.error) || !membership.some(result => result.data?.length)) throw new InvoiceError(400, 'O DROP não pertence a este fechamento.')
      const registrations = await admin.from('drops').select('id,partner').eq('name', drop.data.name)
      if (registrations.error) throw new InvoiceError(503, 'Não foi possível conferir os cadastros.')
      if (registrations.data.filter(candidate => financialPartner(candidate) === financialPartner(period)).length > 1) {
        const explicit = await admin.from('financial_payment_history').select('id').eq('financial_period_id', period.id).eq('drop_id', drop.data.id).eq('is_active', true).limit(1)
        const snapshot = await admin.from('financial_drop_items').select('id').eq('financial_period_id', period.id).contains('registration_snapshot', { dropId: drop.data.id }).eq('is_active', true).limit(1)
        if (explicit.error || snapshot.error || (!explicit.data?.length && !snapshot.data?.length)) throw new InvoiceError(400, 'Há mais de um DROP com este nome e parceiro. Vincule o cadastro correto ao pagamento antes de gerar o link.')
      }
      const linkToken = randomBytes(32).toString('hex')
      const result = await admin.from('financial_invoice_requests').upsert({ financial_period_id: period.id, drop_id: drop.data.id, drop_name: drop.data.name, period_label: period.label, partner: financialPartner(period), reference_cnpj: period.reference_cnpj || 'MOVIDOS', token_hash: hash(linkToken), expires_at: new Date(Date.now() + 30 * 86400000).toISOString(), revoked_at: null, created_by: userId }, { onConflict: 'financial_period_id,drop_id' }).select('id').single()
      if (result.error) throw new InvoiceError(503, 'Não foi possível gerar o link de NF. Confira a migração no Supabase.')
      return res.status(200).json({ token: linkToken, requestId: result.data.id })
    }
    if (input.mode === 'revoke' && uuid.test(input.requestId ?? '')) {
      const result = await admin.from('financial_invoice_requests').update({ revoked_at: new Date().toISOString() }).eq('id', input.requestId).select('id').single()
      if (result.error) throw new InvoiceError(400, 'Não foi possível revogar o link.')
      return res.status(200).json({ revoked: true })
    }
    if (input.mode === 'download' && uuid.test(input.fileId ?? '')) {
      const file = await admin.from('financial_invoice_files').select('storage_path,file_name').eq('id', input.fileId).eq('status', 'received').maybeSingle()
      if (file.error || !file.data) throw new InvoiceError(404, 'Nota fiscal não encontrada.')
      const signed = await admin.storage.from(bucket).createSignedUrl(file.data.storage_path, 60, { download: file.data.file_name })
      if (signed.error || !signed.data?.signedUrl) throw new InvoiceError(503, 'Não foi possível baixar a nota fiscal.')
      return res.status(200).json({ url: signed.data.signedUrl })
    }
    if (input.mode === 'reconcile' && uuid.test(input.fileId ?? '')) {
      const file = await admin.from('financial_invoice_files').select('id,storage_path,content_hash,size_bytes,status').eq('id', input.fileId).maybeSingle()
      if (file.error || !file.data) throw new InvoiceError(404, 'Registro de envio não encontrado.')
      if (file.data.status === 'received') return res.status(200).json({ status: 'received' })
      const stored = await admin.storage.from(bucket).download(file.data.storage_path)
      if (stored.error || !stored.data) throw new InvoiceError(409, 'Arquivo não localizado no armazenamento. Não foi confirmado o recebimento.')
      const content = Buffer.from(await stored.data.arrayBuffer())
      if (content.length !== file.data.size_bytes || hash(content) !== file.data.content_hash) throw new InvoiceError(409, 'O conteúdo armazenado diverge da reserva. Recebimento não confirmado.')
      const confirmed = await admin.from('financial_invoice_files').update({ status: 'received', received_at: new Date().toISOString() }).eq('id', file.data.id).eq('status', file.data.status).select('id').single()
      if (confirmed.error || !confirmed.data) throw new InvoiceError(409, 'O registro mudou. Atualize a lista antes de conferir novamente.')
      return res.status(200).json({ status: 'received' })
    }
    throw new InvoiceError(400, 'Operação inválida.')
  } catch (error) {
    return res.status(error instanceof InvoiceError ? error.status : 500).json({ error: error instanceof InvoiceError ? error.message : 'Não foi possível concluir a operação de nota fiscal.' })
  }
}