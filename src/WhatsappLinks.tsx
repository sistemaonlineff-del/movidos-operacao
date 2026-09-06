import { useEffect } from 'react'

const phoneDigits = (value: string) => value.replace(/\D/g, '')

export default function WhatsappLinks() {
  useEffect(() => {
    const decoratePhones = () => document.querySelectorAll<HTMLTableCellElement>('table tbody td').forEach(cell => {
      const table = cell.closest('table')
      const header = table?.querySelectorAll('thead th')[cell.cellIndex]?.textContent?.trim()
      const number = phoneDigits(cell.textContent ?? '')
      if (header !== 'Telefone' || number.length < 10 || cell.dataset.whatsappReady) return
      cell.dataset.whatsappReady = 'true'
      cell.style.cursor = 'pointer'
      cell.title = 'Abrir conversa no WhatsApp'
      const icon = document.createElement('img')
      icon.src = '/brand/whatsapp.svg'
      icon.alt = 'Abrir WhatsApp'
      icon.width = 18
      icon.height = 18
      icon.style.cssText = 'display:inline-block;vertical-align:middle;margin-left:6px'
      cell.append(icon)
    })
    const openWhatsapp = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      const cell = target?.closest('td')
      const table = cell?.closest('table')
      const header = table?.querySelectorAll('thead th')[cell?.cellIndex ?? -1]?.textContent?.trim()
      if (header !== 'Telefone') return
      const number = phoneDigits(cell?.textContent ?? '')
      if (number.length < 10) return
      event.preventDefault()
      window.open(`https://wa.me/${number.length <= 11 ? `55${number}` : number}`, '_blank', 'noopener,noreferrer')
    }
    const observer = new MutationObserver(decoratePhones)
    decoratePhones()
    observer.observe(document.body, { childList: true, subtree: true })
    document.addEventListener('click', openWhatsapp)
    return () => { observer.disconnect(); document.removeEventListener('click', openWhatsapp) }
  }, [])
  return null
}
