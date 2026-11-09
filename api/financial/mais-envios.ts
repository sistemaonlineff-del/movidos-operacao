import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import { configuredMailer, MailError, mailFailureMessage } from '../../server/closing-mail.js'
import { assertMaisEnviosClosing, maisEnviosSmartKey, type MaisEnviosClosing } from '../../src/maisEnviosClosing.js'
import { createMaisEnviosPdf } from '../../src/maisEnviosReport.js'

export const config = { maxDuration: 60 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Vary', 'Authorization')
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Metodo nao permitido.' }) }
  try {
    const token = typeof req.headers.authorization === 'string' ? /^Bearer\s+(\S+)$/i.exec(req.headers.authorization)?.[1] : null
    if (!token) throw new MailError(401, 'Entre novamente no sistema.')
    const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) throw new MailError(503, 'Servico financeiro indisponivel no servidor.')
    const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
    const auth = await admin.auth.getUser(token)
    if (auth.error || !auth.data.user) throw new MailError(401, 'Sessao invalida.')
    const user = auth.data.user
    const profile = await admin.from('user_profiles').select('role,is_active').eq('id', user.id).maybeSingle()
    if (profile.error) throw new MailError(503, 'Nao foi possivel conferir o perfil financeiro.')
    if (profile.data?.is_active !== true) throw new MailError(403, 'Perfil sem acesso financeiro.')
    if (profile.data.role !== 'admin') {
      const permissions = await admin.from('user_module_permissions').select('financeiro_manage').eq('user_id', user.id).maybeSingle()
      if (permissions.error) throw new MailError(503, 'Nao foi possivel conferir a permissao financeira.')
      if (permissions.data?.financeiro_manage !== true) throw new MailError(403, 'Requer permissao para gerenciar o financeiro.')
    }
    const input = req.body ?? {}
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.closingId ?? '') || typeof input.smart !== 'string' || !input.smart.trim() || input.smart.length > 200) throw new MailError(400, 'Confira o fechamento e a Smart.')
    const saved = await admin.from('mais_envios_closings').select('*').eq('id', input.closingId).maybeSingle()
    if (saved.error) throw new MailError(503, 'Nao foi possivel ler o fechamento Mais Envios. Confira a migracao do banco.')
    if (!saved.data) throw new MailError(404, 'Fechamento nao encontrado.')
    const closing = saved.data as MaisEnviosClosing
    assertMaisEnviosClosing(closing)
    const smartKey = maisEnviosSmartKey(input.smart)
    const contact = closing.contacts.find(row => maisEnviosSmartKey(row.smart) === smartKey)
    if (!contact || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(contact.email)) throw new MailError(400, 'A Smart nao possui e-mail valido salvo neste fechamento.')
    const restricted = process.env.MAIL_TEST_RECIPIENT?.trim().toLowerCase()
    if (restricted && contact.email.toLowerCase() !== restricted) throw new MailError(403, 'Modo de teste ativo no servidor: envio para este destinatario bloqueado.')
    const send = configuredMailer()
    const pdf = Buffer.from(createMaisEnviosPdf(closing, contact.smart).output('arraybuffer'))
    if (pdf.length > 2000000) throw new MailError(413, 'PDF maior que 2 MB. Baixe o rascunho para envio manual.')
    const reserved = await admin.from('mais_envios_closing_mail').insert({ closing_id: closing.id, smart_key: smartKey, recipient: contact.email, status: 'enviando', created_by: user.id }).select('id').single()
    if (reserved.error) {
      if (reserved.error.code !== '23505') throw new MailError(503, 'Nao foi possivel registrar o envio. Nenhum e-mail disparado.')
      const previous = await admin.from('mais_envios_closing_mail').select('status,error_message').eq('closing_id', closing.id).eq('smart_key', smartKey).maybeSingle()
      if (previous.error || !previous.data) throw new MailError(503, 'Nao foi possivel conferir a tentativa anterior. Nao reenvie.')
      if (previous.data.status === 'aceito') return res.status(200).json({ status: 'aceito', duplicate: true })
      throw new MailError(409, 'Envio em andamento ou sem confirmacao. Confira a caixa remetente; nenhum reenvio automatico foi realizado.')
    }
    try { await send({ to: contact.email, subject: closing.subject, body: closing.body, attachmentName: 'fechamento-mais-envios.pdf', pdf }) }
    catch (error) {
      const message = `${mailFailureMessage(error)} Confira a caixa remetente antes de qualquer nova acao.`
      await admin.from('mais_envios_closing_mail').update({ status: 'incerto', error_message: message }).eq('id', reserved.data.id)
      return res.status(502).json({ status: 'incerto', error: message })
    }
    const finished = await admin.from('mais_envios_closing_mail').update({ status: 'aceito', accepted_at: new Date().toISOString(), error_message: null }).eq('id', reserved.data.id)
    if (finished.error) return res.status(202).json({ status: 'incerto', error: 'Provedor aceitou o e-mail, mas o registro final falhou. Nao reenvie; confira a caixa remetente.' })
    return res.status(200).json({ status: 'aceito', duplicate: false })
  } catch (error) {
    return res.status(error instanceof MailError ? error.status : 500).json({ error: error instanceof MailError ? error.message : 'Nao foi possivel concluir o envio Mais Envios.' })
  }
}