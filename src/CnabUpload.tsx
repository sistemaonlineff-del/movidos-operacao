import { ChangeEvent, useState } from 'react'
import { downloadCnabPayments, type CnabPayment } from './cnabInter'
import { readCnabSpreadsheet } from './cnabSpreadsheet'
import { date, money } from './financialData'

export default function CnabUpload() {
  const [fileName, setFileName] = useState(''), [payments, setPayments] = useState<CnabPayment[]>([]), [rowsFound, setRowsFound] = useState(0), [errors, setErrors] = useState<string[]>([]), [message, setMessage] = useState(''), [loading, setLoading] = useState(false)
  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    setPayments([]); setErrors([]); setMessage(''); setRowsFound(0); setFileName(file?.name ?? '')
    if (!file) return
    setLoading(true)
    try { const result = await readCnabSpreadsheet(file); setPayments(result.payments); setRowsFound(result.rowsFound); setErrors(result.errors) }
    catch (caught) { setErrors([(caught as Error).message || 'Não foi possível ler a planilha.']) }
    finally { setLoading(false) }
  }
  const generate = () => {
    try { const count = downloadCnabPayments(payments); setMessage(`Arquivo CNAB gerado com ${count} pagamento(s) e enviado para Downloads.`) }
    catch (caught) { setErrors([(caught as Error).message || 'Não foi possível gerar o CNAB.']) }
  }
  return <section className="finance-visual-page"><section className="card visual-heading"><div><p className="eyebrow">FINANCEIRO</p><h2>Gerar CNAB</h2><p>Anexe a planilha preenchida manualmente. O sistema confere os pagamentos encontrados e gera o arquivo para envio ao banco.</p></div></section><section className="card"><div className="form-grid"><label>Anexar planilha Excel<input aria-label="Anexar planilha Excel" type="file" accept=".xlsx,.xls" onChange={event => void choose(event)} /></label></div><p className="financial-hint">Colunas aceitas: DROP, RESPONSÁVEL, TOTAL DROP, PIX, DATA PAGAMENTO e CPF/CNPJ.</p>{loading && <p role="status" className="form-message">Lendo planilha…</p>}{fileName && !loading && <p role="status" className="form-message">{rowsFound} pagamento(s) encontrado(s) em {fileName}.</p>}{errors.length > 0 && <p role="alert" className="error">{errors.join(' ')}</p>}<div className="financial-actions"><button className="primary" disabled={!payments.length || errors.length > 0} onClick={generate}>Gerar arquivo CNAB</button></div>{message && <p role="status" className="form-message">{message}</p>}</section>{payments.length > 0 && <section className="card"><div className="table-wrap"><table className="cnab-table"><thead><tr>{['DROP', 'RESPONSÁVEL', 'TOTAL DROP', 'PIX', 'DATA PAGAMENTO', 'CPF/CNPJ'].map(title => <th key={title}>{title}</th>)}</tr></thead><tbody>{payments.map((payment, index) => <tr key={`${payment.drop}-${index}`}><td>{payment.drop}</td><td>{payment.responsible || '—'}</td><td>{money(payment.value)}</td><td>{payment.pix}</td><td>{date(payment.paymentDate)}</td><td>{payment.document}</td></tr>)}</tbody></table></div></section>}</section>
}
