import PizZip from 'pizzip'
import Docxtemplater from 'docxtemplater'
import { jsPDF } from 'jspdf'

export async function downloadContractPdf(template: string, data: Record<string, string>, filename: string) {
  const response = await fetch(template)
  if (!response.ok) throw new Error('Modelo do documento não encontrado.')
  const docx = new Docxtemplater(new PizZip(await response.arrayBuffer()), { paragraphLoop: true, linebreaks: true })
  docx.render(data)
  const xml = docx.getZip().file('word/document.xml')?.asText() ?? ''
  const parsed = new DOMParser().parseFromString(xml, 'application/xml')
  const paragraphs = [...parsed.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'p')]
    .map(paragraph => [...paragraph.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 't')].map(node => node.textContent ?? '').join('').trim())
    .filter(Boolean)
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' })
  const margin = 18, width = 174, height = 279
  let y = margin
  paragraphs.forEach((paragraph, index) => {
    const lines = pdf.splitTextToSize(paragraph, width)
    const block = lines.length * 5.3 + 4
    if (y + block > height) { pdf.addPage(); y = margin }
    pdf.setFont('helvetica', index < 2 ? 'bold' : 'normal')
    pdf.setFontSize(index < 2 ? 12 : 9.6)
    pdf.text(lines, margin, y)
    y += block
  })
  pdf.save(filename)
}
