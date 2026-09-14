import { lazy, Suspense } from 'react'
import { useAccess } from './access'
const LabelReader = lazy(() => import('./LabelReader'))

export default function LabelReaderGate() {
  const { loading, canReadLabels } = useAccess()
  if (loading) return <section className="card" role="status">Conferindo acesso...</section>
  if (!canReadLabels) return <section className="card"><h2>Acesso restrito</h2><p>O leitor de etiquetas não está liberado para esta conta. Um administrador pode liberar em Configurações.</p></section>
  return <Suspense fallback={<section className="card">Carregando leitor...</section>}><LabelReader /></Suspense>
}
