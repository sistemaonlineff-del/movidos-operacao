import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { useAccess } from './access'

const defaultMessages = [
  { key: 'ready-message-initial', title: 'Mensagem inicial', text: `Quer aumentar o fluxo de clientes da sua loja e ainda ter uma renda extra? Torne-se um ponto de coleta para grandes transportadoras e você vai conseguir isto.

Estou entrando em contato para procurar um parceiro para ser ponto de coleta, pois na sua região está com uma alta demanda e precisamos encontrar um lojista parceiro.

Como funciona?
Os Sellers vão deixar os pacotes em sua loja durante o dia, você irá bipar os pacotes dando entrada em sistema, guardar em sacas que eu forneço e fechar com lacres que eu também forneço. Ao final do dia, um motorista autorizado passa para coletar as sacas.

Caso tenha interesse em ser ponto de coleta parceiro, peço que me dê um retorno.
Estarei disponível para dúvidas!` },
  { key: 'ready-message-rules', title: 'Regras para abertura', text: `Requisitos:
* Sempre ter um maior de 18 anos no local
* Necessário ser térreo
* Possuir computador, impressora e bipe/leitor de código de barras
* Abertura do ponto no máximo às 09h e fechamento no mínimo às 18h

1. O valor pago é R$ 0,15 por pacote.
2. Os pagamentos ocorrem quinzenalmente, sendo que o primeiro pagamento ocorre em 45 dias, depois fica quinzenal.
3. Faremos um contrato de prestação de serviços e é necessário emitir NF-s.
4. Os pacotes coletados serão da Shein, Kwai e TikTok, podendo agregar outros futuramente, como a Temu.
5. As coletas ocorrem diariamente e a regra é que todos os dias o ponto fique zerado, pois o motorista passa todos os dias.
6. O período mínimo para atuar como ponto de coleta é de 60 dias. Se o ponto quiser sair antes de 60 dias, há multa contratual de R$ 1.000,00. Após os 60 primeiros dias, não há mais multa.
7. Se algum pacote for bipado no seu ponto e você não der saída ou devolver para o vendedor, será considerado extravio e o valor de venda do pacote será descontado.
8. Após a assinatura, enviaremos seus dados para a transportadora aprovar ou não a abertura do ponto de coleta.
9. Os insumos (sacas e lacres) serão enviados por nós. Também daremos o treinamento e todo o suporte necessário para você operar como ponto de coleta.
10. Quando quiser sair, avise com antecedência de 30 dias, pois eles precisam fazer os trâmites internos para encerrar o ponto e normalmente liberam antes dos 30 dias.` },
  { key: 'ready-message-refused', title: 'Ponto recusado / negativa', text: `Olá, boa tarde!

A iMile não aprovou o ponto de coleta neste momento devido a critérios logísticos e de malha regional deles.

Precisamos aguardar a aprovação ou o surgimento de novas rotas na sua área para tentarmos novamente. Mas não se preocupe, estaremos monitorando e, quando liberarem, entraremos em contato prioritariamente.

Sucesso em seus negócios e obrigado pela compreensão!` },
  { key: 'ready-message-data', title: 'Dados necessários', text: `Caso queira prosseguir, basta enviar as seguintes informações:

CNPJ:
Endereço com bairro e cidade/Estado:
CEP:
Horário de funcionamento:
Tamanho:
Nome completo:
CPF:
Telefone:
Telefone:
E-mail:
Chave PIX:
Nome da chave PIX:

Quantos funcionários você tem?
Tem quantos bipes/leitores de código de barras?
Tem impressora A4?
Tem impressora térmica de etiquetas?

Enviar:
* Geolocalização ou link do Google Maps do seu endereço
* Foto da fachada
* Foto do espaço interno` },
]

export default function ReadyMessages() {
  const { isAdmin } = useAccess()
  const [copied, setCopied] = useState('')
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState(defaultMessages)
  const [editing, setEditing] = useState('')
  const [editText, setEditText] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [newText, setNewText] = useState('')
  useEffect(() => {
    if (!supabase) return
    supabase.from('email_templates').select('key,subject,body').like('key', 'ready-message-%').then(({ data }) => {
      if (!data?.length) return
      const defaults = defaultMessages.map(message => {
        const saved = data.find(row => row.key === message.key)
        return saved ? { ...message, title: saved.subject || message.title, text: saved.body || message.text } : message
      })
      setMessages([...defaults, ...data.filter(row => !defaultMessages.some(message => message.key === row.key)).map(row => ({ key: row.key, title: row.subject, text: row.body }))])
    })
    supabase.from('app_notes').select('content').eq('key', 'ready_messages_draft').maybeSingle().then(({ data }) => { if (data?.content) setDraft(data.content) })
  }, [])
  const copy = async (title: string, text: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(title)
    setTimeout(() => setCopied(value => value === title ? '' : value), 1800)
  }
  const startEditing = (key: string, text: string) => { setEditing(key); setEditText(text); setNotice('') }
  const save = async () => {
    const current = messages.find(message => message.key === editing)
    if (!supabase || !current || !editText.trim()) return
    setSaving(true); setNotice('')
    const { data: auth } = await supabase.auth.getUser()
    const { error } = await supabase.from('email_templates').upsert({ key: current.key, subject: current.title, body: editText.trim(), updated_by: auth.user?.id ?? null })
    setSaving(false)
    if (error) { setNotice(error.message); return }
    setMessages(items => items.map(message => message.key === current.key ? { ...message, text: editText.trim() } : message))
    setEditing(''); setEditText(''); setNotice('Mensagem atualizada com sucesso.')
  }
  const create = async () => {
    if (!supabase || !isAdmin || !newTitle.trim() || !newText.trim()) return
    setSaving(true); setNotice('')
    const key = `ready-message-${Date.now()}-${newTitle.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`
    const { data: auth } = await supabase.auth.getUser()
    const { error } = await supabase.from('email_templates').insert({ key, subject: newTitle.trim(), body: newText.trim(), updated_by: auth.user?.id ?? null })
    setSaving(false)
    if (error) { setNotice(error.message); return }
    setMessages(items => [...items, { key, title: newTitle.trim(), text: newText.trim() }]); setNewTitle(''); setNewText(''); setNotice('Novo modelo salvo.')
  }
  const remove = async (key: string) => {
    if (!supabase || !isAdmin || !confirm('Excluir este modelo de mensagem?')) return
    const { error } = await supabase.from('email_templates').delete().eq('key', key)
    if (error) { setNotice(error.message); return }
    setMessages(items => items.filter(message => message.key !== key)); setNotice('Modelo excluído.')
  }
  const saveDraft = async () => {
    if (!supabase) return
    setSaving(true); setNotice('')
    const { data: auth } = await supabase.auth.getUser()
    const { error } = await supabase.from('app_notes').upsert({ key: 'ready_messages_draft', content: draft, updated_by: auth.user?.id ?? null })
    setSaving(false); setNotice(error ? error.message : 'Rascunho salvo com sucesso.')
  }
  return <section className="ready-messages">
    <section className="card visual-heading"><div><p className="eyebrow">ATENDIMENTO</p><h2>Mensagens prontas</h2><p>Textos do cadastro-base antigo, prontos para copiar e enviar.</p></div></section>
    {isAdmin && <section className="card ready-message-create"><h3>Novo modelo</h3><div className="form-grid"><label className="full">Título<input value={newTitle} onChange={event => setNewTitle(event.target.value)} placeholder="Ex.: Cobrança de documentos" /></label><label className="full">Mensagem<textarea value={newText} onChange={event => setNewText(event.target.value)} placeholder="Escreva o novo texto pronto…" /></label></div><button className="primary compact" disabled={saving || !newTitle.trim() || !newText.trim()} onClick={() => void create()}>{saving ? 'Salvando…' : 'Salvar novo modelo'}</button></section>}
    <div className="ready-message-grid"><article className="card ready-message ready-message-draft">
      <div className="ready-message-heading"><h3>Rascunho</h3><div className="ready-message-actions"><button className="secondary" disabled={saving} onClick={() => void saveDraft()}>{saving ? 'Salvando…' : 'Salvar rascunho'}</button><button className="secondary" disabled={!draft.trim()} onClick={() => void copy('Rascunho', draft)}>{copied === 'Rascunho' ? 'Copiado!' : 'Copiar rascunho'}</button></div></div>
      <textarea value={draft} onChange={event => setDraft(event.target.value)} placeholder="Escreva aqui uma mensagem livre…" aria-label="Rascunho de mensagem" />
    </article>{messages.map(message => <article className="card ready-message" key={message.key}>
      <div className="ready-message-heading"><h3>{message.title}</h3><div className="ready-message-actions">{isAdmin && <button className="secondary" onClick={() => startEditing(message.key, message.text)}>Editar</button>}<button className="secondary" onClick={() => void copy(message.title, message.text)}>{copied === message.title ? 'Copiado!' : 'Copiar mensagem'}</button>{isAdmin && <button className="secondary" onClick={() => void remove(message.key)}>Excluir</button>}</div></div>
      {editing === message.key ? <div className="ready-message-edit"><textarea value={editText} onChange={event => setEditText(event.target.value)} aria-label={`Editar ${message.title}`} /><div><button type="button" onClick={() => { setEditing(''); setEditText('') }}>Cancelar</button><button type="button" className="primary compact" disabled={saving || !editText.trim()} onClick={() => void save()}>{saving ? 'Salvando…' : 'Salvar mensagem'}</button></div></div> : <pre>{message.text}</pre>}
    </article>)}</div>
    {notice && <p className="form-message" role="status">{notice}</p>}
  </section>
}
