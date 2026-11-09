import { LogOut, ScanLine } from 'lucide-react'
import LabelReaderGate from './LabelReaderGate'
import './label-reader-portal.css'

export default function LabelReaderPortal({ onExit }: { onExit: () => void }) {
  return <main className="label-reader-portal">
    <header className="reader-portal-header">
      <div><ScanLine size={23} aria-hidden="true"/><h1>Leitor de etiquetas</h1></div>
      <button type="button" title="Sair da conta" aria-label="Sair da conta" onClick={onExit}><LogOut size={18} aria-hidden="true"/>Sair</button>
    </header>
    <LabelReaderGate />
  </main>
}