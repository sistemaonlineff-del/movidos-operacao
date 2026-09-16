import nodemailer from 'nodemailer'

export type ClosingMail = { to: string; subject: string; body: string; attachmentName: string; pdf: Buffer }
export class MailError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}

export function configuredMailer(createTransport = nodemailer.createTransport) {
  const env = process.env
  const from = env.MAIL_FROM?.trim() ?? ''
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(from)) throw new MailError(503, 'Configure a conta remetente no servidor antes de enviar.')
  if (env.MAIL_PROVIDER === 'microsoft365') {
    const tenant = env.MAIL_MS_TENANT_ID?.trim()
    const client = env.MAIL_MS_CLIENT_ID?.trim()
    const secret = env.MAIL_MS_CLIENT_SECRET
    if (!tenant || !/^[a-zA-Z0-9.-]+$/.test(tenant) || !client || !secret) throw new MailError(503, 'A conexão Microsoft 365 ainda não foi configurada no servidor.')
    return async (mail: ClosingMail) => {
      const tokenResponse = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
        method: 'POST', signal: AbortSignal.timeout(15000),
        body: new URLSearchParams({ client_id: client, client_secret: secret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
      })
      if (!tokenResponse.ok) throw new MailError(502, 'Não foi possível autorizar a conta Microsoft 365. Confira a configuração do servidor.')
      const token = await tokenResponse.json() as { access_token?: string }
      if (!token.access_token) throw new MailError(502, 'A Microsoft não autorizou o envio.')
      const response = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
        method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { subject: mail.subject, body: { contentType: 'Text', content: mail.body }, toRecipients: [{ emailAddress: { address: mail.to } }], attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: mail.attachmentName, contentType: 'application/pdf', contentBytes: mail.pdf.toString('base64') }] }, saveToSentItems: true }),
      })
      if (response.status !== 202) throw new MailError(502, 'A Microsoft não confirmou o envio. Confira a caixa de saída antes de tentar novamente.')
      return 'microsoft365'
    }
  }
  if (env.MAIL_PROVIDER === 'smtp') {
    const host = env.MAIL_SMTP_HOST?.trim()
    const port = Number(env.MAIL_SMTP_PORT || 465)
    const user = env.MAIL_SMTP_USER?.trim()
    const pass = env.MAIL_SMTP_PASSWORD
    if (!host || ![465, 587].includes(port) || !user || !pass) throw new MailError(503, 'A conexão SMTP ainda não foi configurada no servidor.')
    return async (mail: ClosingMail) => {
      const transport = createTransport({ host, port, secure: port === 465, requireTLS: true, auth: { user, pass }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000, tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true } })
      try {
        const result = await transport.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.body, attachments: [{ filename: mail.attachmentName, content: mail.pdf, contentType: 'application/pdf' }], disableFileAccess: true, disableUrlAccess: true })
        if (!result.accepted.length || result.rejected.length) throw new MailError(502, 'O servidor de e-mail não aceitou o destinatário.')
        return 'smtp'
      } finally { transport.close() }
    }
  }
  throw new MailError(503, 'O envio direto ainda não foi configurado no servidor.')
}