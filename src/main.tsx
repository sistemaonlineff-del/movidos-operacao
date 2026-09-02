import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './styles.css'
import './navigation.css'
import './formatting.css'
import './clean-ui.css'
import './brand.css'

const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO']
let municipalitiesLoaded = false
document.addEventListener('focusin', (event) => {
  const target = event.target as HTMLInputElement | HTMLSelectElement
  const label = target.closest('label')
  const labelText = label?.childNodes[0]?.textContent?.trim()
  if (labelText === 'UF' && target.tagName === 'SELECT') {
    target.innerHTML = `<option value="">Selecionar</option>${UFS.map(uf => `<option>${uf}</option>`).join('')}`
  }
  if (labelText === 'Município') {
    if (municipalitiesLoaded) return
    fetch('https://servicodados.ibge.gov.br/api/v1/localidades/municipios')
      .then(response => response.json())
      .then((items: Array<{ nome: string }>) => {
        const options = `<option value="">Selecionar</option>${items.map(item => `<option>${item.nome.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}</option>`).join('')}`
        if (target.tagName === 'SELECT') target.innerHTML = options
        else { const list = document.createElement('datalist'); list.id = 'municipios-brasil'; list.innerHTML = options; document.body.appendChild(list); target.setAttribute('list', 'municipios-brasil') }
        municipalitiesLoaded = true
      })
      .catch(() => { if (target.tagName === 'SELECT') target.innerHTML = '<option>São Paulo</option><option>Diadema</option><option>Suzano</option>' })
  }
})

const timeOptions = ['08:00','08:30','09:00','09:30','10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30','14:00','14:30','15:00','15:30','16:00','16:30','17:00','17:30','18:00','18:30','19:00','19:30','20:00','20:30']
const applyTimeSelects = () => document.querySelectorAll('label').forEach(label => {
  const text = label.childNodes[0]?.textContent?.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  if (!['Abertura semanal','Fechamento semanal','Abertura sabado','Fechamento sabado'].includes(text || '')) return
  const input = label.querySelector('input')
  if (!input || input.dataset.timeReady) return
  const select = document.createElement('select'); select.dataset.timeReady = 'true'; select.innerHTML = `<option value="">Selecionar</option>${timeOptions.map(hour => `<option${input.placeholder === hour ? ' selected' : ''}>${hour}</option>`).join('')}`
  input.replaceWith(select)
})
new MutationObserver(applyTimeSelects).observe(document.body, { childList: true, subtree: true })

const cadastroFilterColumns: Record<string, number> = { Status: 1, Parceiro: 3, Responsável: 4, Município: 6, UF: 6, Zona: 7 }
const enhanceCadastroList = () => {
  if (location.pathname !== '/cadastros') return
  const rows = Array.from(document.querySelectorAll<HTMLTableRowElement>('tbody tr'))
  document.querySelectorAll<HTMLLabelElement>('.filter-grid label').forEach(label => {
    const name = label.childNodes[0]?.textContent?.trim() || ''
    const index = cadastroFilterColumns[name]
    const input = label.querySelector('input')
    if (index === undefined || !input || input.dataset.dimensionReady) return
    const values = [...new Set(rows.map(row => row.cells[index]?.textContent?.trim()).filter(Boolean))].sort()
    const select = document.createElement('select'); select.dataset.dimensionReady = 'true'; select.dataset.column = String(index)
    select.innerHTML = `<option value="">Todos</option>${values.map(value => `<option>${value}</option>`).join('')}`
    input.replaceWith(select)
  })
}
new MutationObserver(enhanceCadastroList).observe(document.body, { childList: true, subtree: true })
document.addEventListener('change', event => {
  const select = event.target as HTMLSelectElement
  if (!select.dataset.column) return
  const filters = Array.from(document.querySelectorAll<HTMLSelectElement>('.filter-grid select[data-column]'))
  document.querySelectorAll<HTMLTableRowElement>('tbody tr').forEach(row => { row.style.display = filters.every(filter => !filter.value || row.cells[Number(filter.dataset.column)]?.textContent?.includes(filter.value)) ? '' : 'none' })
})
document.addEventListener('click', event => {
  const button = event.target as HTMLButtonElement
  if (button.textContent?.trim() !== 'Editar') return
  const row = button.closest('tr'); if (!row) return
  const cells = Array.from(row.cells).map(cell => cell.textContent?.trim() || '')
  sessionStorage.setItem('movidos-edit', JSON.stringify({ id: cells[0], status: cells[1], drop: cells[2], partner: cells[3], responsible: cells[4], phone: cells[5], address: cells[6], zone: cells[7] }))
  location.href = '/cadastros/novo'
})
const populateEditForm = () => {
  if (location.pathname !== '/cadastros/novo') return
  const raw = sessionStorage.getItem('movidos-edit'); if (!raw) return
  const data = JSON.parse(raw) as Record<string,string>
  const fields: Record<string,string> = { ID:data.id, Status:data.status, 'Nome do Drop':data.drop, 'Parceiro logístico':data.partner, Responsável:data.responsible, Telefone:data.phone, Logradouro:data.address, 'Zona / Região':data.zone }
  document.querySelectorAll<HTMLLabelElement>('.cadastro-form label').forEach(label => { const name = label.childNodes[0]?.textContent?.trim(); const control = label.querySelector<HTMLInputElement|HTMLSelectElement>('input,select'); if (name && control && fields[name]) { control.value = fields[name] } })
}
new MutationObserver(populateEditForm).observe(document.body, { childList: true, subtree: true })

const labelOf = (element: HTMLElement) => element.closest('label')?.childNodes[0]?.textContent?.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '') || ''
const digits = (value: string) => value.replace(/\D/g, '')
const formatCpf = (value: string) => digits(value).slice(0, 11).replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2')
const formatCnpj = (value: string) => digits(value).slice(0, 14).replace(/(\d{2})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1/$2').replace(/(\d{4})(\d{1,2})$/, '$1-$2')
const formatPhone = (value: string) => { const number = digits(value).slice(0, 11); return number.length <= 10 ? number.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{4})(\d{1,4})$/, '$1-$2') : number.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d{1,4})$/, '$1-$2') }
const formatCep = (value: string) => digits(value).slice(0, 8).replace(/(\d{5})(\d)/, '$1-$2')
const formatCurrency = (value: string) => (Number(digits(value) || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
document.addEventListener('input', (event) => {
  const input = event.target as HTMLInputElement
  if (input.tagName !== 'INPUT') return
  const label = labelOf(input)
  if (label === 'Numero' || label === 'CEP' || label === 'Telefone' || label === 'CPF' || label === 'CNPJ' || label === 'Valor acordado (R$)') {
    if (label === 'Numero') input.value = digits(input.value)
    if (label === 'CEP') input.value = formatCep(input.value)
    if (label === 'Telefone') input.value = formatPhone(input.value)
    if (label === 'CPF') input.value = formatCpf(input.value)
    if (label === 'CNPJ') input.value = formatCnpj(input.value)
    if (label === 'Valor acordado (R$)') input.value = formatCurrency(input.value)
  }
  if (label === 'Latitude' || label === 'Longitude') input.value = input.value.replace(',', '.').replace(/[^0-9.-]/g, '').replace(/(?!^)-/g, '')
  if (input.dataset.pixType === 'cpf') input.value = formatCpf(input.value)
  if (input.dataset.pixType === 'cnpj') input.value = formatCnpj(input.value)
  if (input.dataset.pixType === 'telefone') input.value = formatPhone(input.value)
})
document.addEventListener('focusout', (event) => {
  const input = event.target as HTMLInputElement
  const label = labelOf(input)
  if ((label === 'Latitude' || label === 'Longitude') && input.value && !Number.isNaN(Number(input.value))) input.value = Number(input.value).toFixed(6)
})
document.addEventListener('focusin', (event) => {
  const input = event.target as HTMLInputElement
  if (input.tagName !== 'INPUT' || labelOf(input) !== 'Chave PIX' || input.dataset.pixReady) return
  input.dataset.pixReady = 'true'
  const container = document.createElement('div'); container.className = 'pix-control'
  const type = document.createElement('select'); type.innerHTML = '<option value="">Tipo da chave</option><option value="cpf">CPF</option><option value="cnpj">CNPJ</option><option value="telefone">Telefone</option><option value="email">E-mail</option><option value="aleatoria">Chave aleatória</option>'
  const key = document.createElement('input'); key.placeholder = 'Selecione o tipo de chave'; key.disabled = true
  type.addEventListener('change', () => { key.disabled = !type.value; key.dataset.pixType = type.value; key.type = type.value === 'email' ? 'email' : 'text'; key.placeholder = ({ cpf:'000.000.000-00', cnpj:'00.000.000/0000-00', telefone:'(00) 00000-0000', email:'email@exemplo.com', aleatoria:'Cole a chave aleatória' } as Record<string,string>)[type.value] || 'Selecione o tipo'; const name = document.querySelector<HTMLInputElement>('label:nth-of-type(1) input') })
  input.replaceWith(container); container.append(type, key)
})

createRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter><App /></BrowserRouter></StrictMode>)
applyTimeSelects()
