import { useEffect } from 'react'

const phoneDigits = (value: string) => value.replace(/\D/g, '')

export default function WhatsappLinks() {
  useEffect(() => {
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
    document.addEventListener('click', openWhatsapp)
    return () => document.removeEventListener('click', openWhatsapp)
  }, [])
  return null
}
