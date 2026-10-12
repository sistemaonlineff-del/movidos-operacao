import { ChangeEvent, useState } from 'react'
import { downloadCnabPayments, type CnabPayment } from './cnabInter'
import { downloadCnabTemplate, readCnabSpreadsheet } from './cnabSpreadsheet'
import { date, money } from './financialData'

export default function CnabUpload() {
  const [defaultDate, setDefaultDate] = useState(() => new Date().toLocaleDateString('sv-SE'))
  const [generationError, setGenerationError] = useState('')
  const [fileName,setFileName]=useState(''),[payments,setPayments]=useState<CnabPayment[]>([]),[rowsFound,setRowsFound]=useState(0),[errors,setErrors]=useState<string[]>([]),[message,setMessage]=useState(''),[loading,setLoading]=useState(false)
  const choose=async(event:ChangeEvent<HTMLInputElement>)=>{const file=event.target.files?.[0];setPayments([]);setErrors([]);setMessage('');setRowsFound(0);setFileName(file?.name??'');if(!file)return;setLoading(true);try{const result=await readCnabSpreadsheet(file);setPayments(result.payments);setRowsFound(result.rowsFound);setErrors(result.errors)}catch(error){setErrors([(error as Error).message||'Não foi possível ler a planilha.'])}finally{setLoading(false)}}
  const generate=()=>{setGenerationError('');try{if(payments.some(payment=>!payment.paymentDate)&&!defaultDate)throw new Error('Informe a data padrão para os pagamentos sem data.');const count=downloadCnabPayments(payments.map(payment=>({...payment,paymentDate:payment.paymentDate||defaultDate})));setMessage(`Arquivo CNAB gerado com ${count} pagamento(s) e enviado para Downloads.`)}catch(error){setGenerationError((error as Error).message||'Não foi possível gerar o CNAB.')}}
  const visibleErrors=[...errors,...(generationError?[generationError]:[])]
  return <section className="finance-visual-page">
    <section className="card visual-heading"><div><p className="eyebrow">FINANCEIRO</p><h2>Gerar CNAB</h2></div><button className="secondary" onClick={()=>void downloadCnabTemplate()}>Baixar modelo de planilha</button></section>
    <section className="card"><div className="form-grid">
      <label>Anexar planilha Excel<input aria-label="Anexar planilha Excel" type="file" accept=".xlsx,.xls" onChange={event=>{setGenerationError('');void choose(event)}}/></label>
      <label>Data padrão para pagamentos sem data<input aria-label="Data padrão para pagamentos sem data" type="date" value={defaultDate} onChange={event=>{setDefaultDate(event.target.value);setGenerationError('')}}/></label>
    </div>{loading&&<p role="status" className="form-message">Lendo planilha…</p>}{fileName&&!loading&&<p role="status" className="form-message">{rowsFound} pagamento(s) encontrado(s) em {fileName}.</p>}
      {visibleErrors.length>0&&<p role="alert" className="error">{visibleErrors.join(' ')}</p>}
      <div className="financial-actions"><button className="primary" disabled={loading||!payments.length||errors.length>0} onClick={generate}>Gerar arquivo CNAB</button></div>{message&&<p role="status" className="form-message">{message}</p>}
    </section>
    {payments.length>0&&<section className="card"><div className="table-wrap"><table className="cnab-table"><thead><tr>{['DROP','RESPONSÁVEL','TOTAL DROP','PIX','DATA PAGAMENTO','CPF/CNPJ'].map(title=><th key={title}>{title}</th>)}</tr></thead><tbody>{payments.map((payment,index)=><tr key={`${payment.drop}-${index}`}><td>{payment.drop}</td><td>{payment.responsible||'—'}</td><td>{money(payment.value)}</td><td>{payment.pix}</td><td>{date(payment.paymentDate||defaultDate)}</td><td>{payment.document||'—'}</td></tr>)}</tbody></table></div></section>}
  </section>
}
