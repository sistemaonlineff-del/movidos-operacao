import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { jsPDF } from 'jspdf'
import { configuredMailer, MailError, mailFailureMessage, verifyMailConnection, type ClosingMail } from '../../server/closing-mail.js'
import { financialPartner } from '../../src/financialData.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const emailAddress = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/
const testRecipient = 'fabioaf9@gmail.com'

async function deliver(admin: SupabaseClient, res: VercelResponse, record: Record<string, unknown>, mail: ClosingMail, send: ReturnType<typeof configuredMailer>, offerTestRetry = false) {
  const { data: log, error: reserveError } = await admin.from('email_logs').insert(record).select('id').single()
  if (reserveError) {
    if (reserveError.code !== '23505') throw new MailError(503, 'Não foi possível registrar o envio. Nenhum e-mail foi disparado.')
    const { data: previous, error } = await admin.from('email_logs').select('id,status,error_message').eq('delivery_key', record.delivery_key).maybeSingle()
    if (error || !previous) throw new MailError(503, 'Não foi possível conferir o envio anterior. Não repita o disparo.')
    if (previous.status === 'aceito') return res.status(200).json({ status: 'aceito', duplicate: true })
    return res.status(409).json({ status: 'incerto', error: previous.error_message || 'Há um envio em andamento ou sem confirmação. Confira a caixa remetente antes de repetir.', retryOf: offerTestRetry && previous.status === 'incerto' ? previous.id : undefined })
  }
  try {
    await send(mail)
  } catch (caught) {
    const message = `${mailFailureMessage(caught)} Confira a caixa remetente; não houve tentativa automática de reenvio.`
    await admin.from('email_logs').update({ status: 'incerto', error_message: message }).eq('id', log.id)
    return res.status(502).json({ status: 'incerto', error: message, retryOf: offerTestRetry ? log.id : undefined })
  }
  const { error: finishError } = await admin.from('email_logs').update({ status: 'aceito', sent_at: new Date().toISOString(), error_message: null }).eq('id', log.id)
  if (finishError) return res.status(202).json({ status: 'incerto', error: 'O provedor aceitou o e-mail, mas o registro final falhou. Não reenvie; confira a caixa remetente.' })
  return res.status(200).json({ status: 'aceito', duplicate: false })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (!['GET', 'POST'].includes(req.method ?? '')) return res.status(405).json({ error: 'Método não permitido.' })
  try {
    const token = typeof req.headers.authorization === 'string' ? /^Bearer\s+(\S+)$/i.exec(req.headers.authorization)?.[1] : null
    if (!token) throw new MailError(401, 'Entre novamente no sistema.')
    const url = process.env.SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !serviceKey) throw new MailError(503, 'O serviço de e-mail ainda não está configurado no servidor.')
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
    const { data: auth, error: authError } = await admin.auth.getUser(token)
    if (authError || !auth.user) throw new MailError(401, 'Sessão inválida. Entre novamente no sistema.')
    const { data: profile, error: profileError } = await admin.from('user_profiles').select('role,is_active').eq('id', auth.user.id).maybeSingle()
    if (profileError) throw new MailError(503, 'Não foi possível conferir o acesso financeiro.')
    if (profile?.is_active !== true) throw new MailError(403, 'Usuário sem permissão de envio.')
    if (profile.role !== 'admin') {
      const { data: permission, error } = await admin.from('user_module_permissions').select('financeiro_manage').eq('user_id', auth.user.id).maybeSingle()
      if (error) throw new MailError(503, 'Não foi possível conferir a permissão financeira.')
      if (permission?.financeiro_manage !== true) throw new MailError(403, 'É necessária permissão para gerenciar o financeiro.')
    }
    if (req.method === 'POST' && req.body?.mode === 'verify') {
      if (profile.role !== 'admin') throw new MailError(403, 'Somente administrador pode verificar a conexão de e-mail.')
      await verifyMailConnection()
      return res.status(200).json({ status: 'verified', message: 'Conexão e autenticação SMTP verificadas. Nenhum e-mail foi enviado. Isso não confirma a entrega da tentativa anterior nem libera seu reenvio.' })
    }
    const send = configuredMailer()
    const { error: schemaError } = await admin.from('email_logs').select('delivery_key').limit(1)
    if (schemaError) throw new MailError(503, 'A atualização do banco para envio direto ainda não foi aplicada.')
    if (req.method === 'GET') return res.status(200).json({ configured: true, from: process.env.MAIL_FROM?.trim() })
    const input = req.body ?? {}
    if (input.mode === 'test') {
      if (profile.role !== 'admin') throw new MailError(403, 'Somente administrador pode enviar o e-mail de teste.')
      if (process.env.MAIL_TEST_RECIPIENT && process.env.MAIL_TEST_RECIPIENT.trim().toLowerCase() !== testRecipient) throw new MailError(403, 'O destinatário de teste configurado no servidor difere do destinatário autorizado.')
      const subject = 'MOVIDOS - Teste de envio de e-mail'
      let deliveryKey = createHash('sha256').update(`mail-test:${testRecipient}:${new Date().toISOString().slice(0, 10)}`).digest('hex')
      const retryRequested = input.retryOf != null
      if (retryRequested) {
        if (typeof input.retryOf !== 'string' || !uuid.test(input.retryOf) || input.reconciled !== true) throw new MailError(400, 'Confirme a conferência das caixas de e-mail antes de autorizar uma repetição do teste.')
        const { data: previous, error } = await admin.from('email_logs').select('id,delivery_key,status,sent_at,recipient_email,subject,attachment_name,drop_name_snapshot,drop_id,financial_period_id').eq('id', input.retryOf).maybeSingle()
        if (error) throw new MailError(503, 'Não foi possível conferir a tentativa anterior. Nenhum e-mail foi enviado.')
        if (!previous || previous.status !== 'incerto' || previous.recipient_email !== testRecipient || previous.subject !== subject || previous.attachment_name !== 'movidos-teste-email.pdf' || previous.drop_name_snapshot !== 'TESTE FICTICIO' || previous.drop_id != null || previous.financial_period_id != null || !previous.sent_at || !Number.isFinite(Date.parse(previous.sent_at))) throw new MailError(409, 'Somente o teste fictício original sem confirmação pode ter uma repetição autorizada.')
        const originalKey = createHash('sha256').update(`mail-test:${testRecipient}:${new Date(previous.sent_at).toISOString().slice(0, 10)}`).digest('hex')
        if (previous.delivery_key !== originalKey) throw new MailError(409, 'Esta tentativa não permite outra repetição. Confira as caixas de e-mail antes de qualquer nova ação.')
        deliveryKey = createHash('sha256').update(`mail-test-retry:${previous.id.toLowerCase()}`).digest('hex')
      }
      const body = 'Este e um teste autorizado do envio direto do sistema MOVIDOS. O PDF anexo contem somente dados ficticios. Nenhum fechamento real foi enviado.'
      const document = new jsPDF()
      document.text(['MOVIDOS - TESTE DE E-MAIL', '', 'Documento ficticio, sem valor financeiro.', 'Nenhum dado de DROP ou fechamento real.', `Destinatario: ${testRecipient}`], 20, 25)
      const pdf = Buffer.from(document.output('arraybuffer'))
      const attachmentName = 'movidos-teste-email.pdf'
      return await deliver(admin, res, { delivery_key: deliveryKey, recipient_email: testRecipient, subject, attachment_name: attachmentName, drop_name_snapshot: 'TESTE FICTICIO', status: 'enviando', created_by: auth.user.id }, { to: testRecipient, subject, body, attachmentName, pdf }, send, !retryRequested)
    }
    if (input.mode != null) throw new MailError(400, 'Modo de envio inválido.')
    if (!uuid.test(input.dropId ?? '') || !uuid.test(input.periodId ?? '')) throw new MailError(400, 'DROP ou período inválido.')
    const subject = typeof input.subject === 'string' ? input.subject.trim() : ''
    const body = typeof input.body === 'string' ? input.body.trim() : ''
    if (!subject || subject.length > 200 || /[\r\n]/.test(subject) || !body || body.length > 30000) throw new MailError(400, 'Confira o assunto e o texto do e-mail.')
    if (typeof input.pdf !== 'string' || !input.pdf.length || input.pdf.length > 1400000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.pdf)) throw new MailError(400, 'Anexo PDF inválido ou maior que 1 MB.')
    const pdf = Buffer.from(input.pdf, 'base64')
    if (pdf.subarray(0, 5).toString() !== '%PDF-' || !pdf.subarray(-1024).includes(Buffer.from('%%EOF'))) throw new MailError(400, 'Anexo não reconhecido como PDF.')
    const [{ data: drop, error: dropError }, { data: period, error: periodError }] = await Promise.all([
      admin.from('drops').select('id,name,email,responsible').eq('id', input.dropId).eq('is_active', true).maybeSingle(),
      admin.from('financial_periods').select('*').eq('id', input.periodId).eq('is_active', true).maybeSingle(),
    ])
    if (dropError || periodError) throw new MailError(503, 'Não foi possível conferir os dados do fechamento.')
    if (!drop || !period || period.label !== input.period || financialPartner(period) !== input.partner) throw new MailError(400, 'O DROP ou período não corresponde ao fechamento selecionado.')
    if (!emailAddress.test(drop.email ?? '')) throw new MailError(400, 'Cadastre um único e-mail válido no DROP antes de enviar.')
    if (process.env.MAIL_TEST_RECIPIENT && drop.email.toLowerCase() !== process.env.MAIL_TEST_RECIPIENT.trim().toLowerCase()) throw new MailError(403, 'Modo de teste: destinatário não autorizado. Nenhum e-mail foi enviado.')
    const membership = await Promise.all(['financial_drop_items', 'financial_payment_history'].map(table => admin.from(table).select('id').eq('financial_period_id', period.id).eq('drop_name_snapshot', drop.name).eq('is_active', true).limit(1)))
    if (membership.some(result => result.error)) throw new MailError(503, 'Não foi possível conferir os itens do DROP.')
    if (!membership.some(result => result.data?.length)) throw new MailError(400, 'O DROP não possui itens neste fechamento.')
    const attachmentName = 'fechamento.pdf'
    const deliveryKey = createHash('sha256').update(JSON.stringify([period.financial_view_id || period.id, period.label, input.partner, drop.id])).digest('hex')
    return await deliver(admin, res, { delivery_key: deliveryKey, financial_period_id: period.id, drop_id: drop.id, recipient_email: drop.email, period_label: period.label, partner: input.partner, drop_name_snapshot: drop.name, responsible: drop.responsible, subject, attachment_name: attachmentName, status: 'enviando', created_by: auth.user.id }, { to: drop.email, subject, body, attachmentName, pdf }, send)
  } catch (error) {
    return res.status(error instanceof MailError ? error.status : 500).json({ error: error instanceof MailError ? error.message : 'Não foi possível concluir a solicitação de envio.' })
  }
}