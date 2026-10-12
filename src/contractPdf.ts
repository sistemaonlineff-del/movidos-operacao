import PizZip from 'pizzip'
import Docxtemplater from 'docxtemplater'
import { jsPDF } from 'jspdf'
import { supabase } from './lib/supabase'

async function activeTemplate(template: string) {
  if (!supabase) return template
  const { data: session } = await supabase.auth.getSession()
  const response = await fetch('/api/contract-templates', { headers: { Authorization: `Bearer ${session.session?.access_token ?? ''}` } })
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Não foi possível consultar o modelo ativo. Nenhum documento foi gerado.')
  const config = await response.json()
  const path=template.includes('distrato')?config.terminationTemplatePath:config.serviceTemplatePath
  if (!path) return template
  const { data, error } = await supabase.storage.from('movidos-documents').createSignedUrl(path, 120)
  if(error||!data?.signedUrl)throw new Error('O modelo personalizado não está disponível. Nenhum documento foi gerado.')
  return data.signedUrl
}

export type ContractParagraph = { text: string; bold?: boolean; align?: 'left'|'center'|'right'|'justify'; pageBreak?: boolean }
export function renderContractPdf(paragraphs: ContractParagraph[]) {
  const pdf = new jsPDF({unit:'mm',format:'a4'})
  const margin=22, width=162, bottom=271, lineHeight=5.3
  let cursor=25
  paragraphs.forEach((paragraph,index)=>{
    const title=index===0
    const heading=title||paragraph.bold||/^CL[ÁA]USULA/.test(paragraph.text)
    pdf.setFont('times',heading?'bold':'normal')
    pdf.setFontSize(title?14:11)
    const lines: string[]=pdf.splitTextToSize(paragraph.text,width)
    if(paragraph.pageBreak&&cursor>25){pdf.addPage();cursor=25}
    const following=heading&&paragraphs[index+1]?lineHeight*3+5:0
    if(cursor+Math.min(lines.length,3)*lineHeight+following>bottom){pdf.addPage();cursor=25}
    const align=paragraph.align??(title?'center':'left')
    lines.forEach((line,lineIndex)=>{
      if(cursor+lineHeight>bottom){pdf.addPage();cursor=25}
      const alignment=align==='justify'&&lineIndex===lines.length-1?'left':align
      pdf.text(line,alignment==='center'?105:alignment==='right'?188:margin,cursor,{align:alignment,maxWidth:width})
      cursor+=title?6.5:lineHeight
    })
    cursor+=heading?5:3
  })
  const pages=pdf.getNumberOfPages()
  for(let page=1;page<=pages;page++){
    pdf.setPage(page);pdf.setDrawColor(190);pdf.line(22,280,188,280);pdf.setFont('times','normal');pdf.setFontSize(9)
    pdf.text(`MOVIDOS | ${page} / ${pages}`,188,286,{align:'right'})
  }
  return pdf
}

export async function downloadContractPdf(template: string, data: Record<string, string>, filename: string) {
  const response = await fetch(await activeTemplate(template))
  if (!response.ok) throw new Error('Modelo do documento não encontrado.')
  const docx = new Docxtemplater(new PizZip(await response.arrayBuffer()), { paragraphLoop: true, linebreaks: true })
  docx.render(data)
  const xml = docx.getZip().file('word/document.xml')?.asText() ?? ''
  const parsed = new DOMParser().parseFromString(xml, 'application/xml')
  const paragraphs = [...parsed.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'p')]
    .map(paragraph => {
      const namespace='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
      const runs=[...paragraph.getElementsByTagNameNS(namespace,'r')].filter(run=>run.getElementsByTagNameNS(namespace,'t').length)
      const text=[...paragraph.getElementsByTagNameNS(namespace,'t')].map(node=>node.textContent??'').join('').trim()
      const alignment=paragraph.getElementsByTagNameNS(namespace,'jc')[0]?.getAttributeNS(namespace,'val')
      return {text,bold:runs.length>0&&runs.every(run=>[...run.getElementsByTagNameNS(namespace,'b')].some(node=>!['0','false'].includes(node.getAttributeNS(namespace,'val')??''))),align:(alignment==='both'?'justify':['left','center','right'].includes(alignment??'')?alignment:undefined) as ContractParagraph['align'],pageBreak:paragraph.getElementsByTagNameNS(namespace,'pageBreakBefore').length>0}
    }).filter(paragraph=>paragraph.text)
  const contractFields = [data.dataContrato ? `Data do contrato: ${data.dataContrato}` : '']
  if (template.includes('distrato')) contractFields.push(
    data.dataDistrato ? `Data do distrato: ${data.dataDistrato}` : '',
    data.motivoDistrato ? `Motivo do distrato: ${data.motivoDistrato}` : '',
  )
  const extra:ContractParagraph[]=contractFields.filter(Boolean).map(text=>({text}))
  renderContractPdf([paragraphs[0],...extra,...paragraphs.slice(1)].filter(Boolean)).save(filename)
}
