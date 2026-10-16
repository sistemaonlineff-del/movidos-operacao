import { lazy, Suspense, useLayoutEffect } from 'react'
import { useAccess } from './access'
const LabelReader = lazy(() => import('./LabelReader'))

export default function LabelReaderGate() {
  const { loading, canReadLabels } = useAccess()
  useLayoutEffect(() => {
    const existing = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    const viewport = existing ?? document.createElement('meta')
    const previousContent = viewport.getAttribute('content')
    viewport.name = 'viewport'
    viewport.content = 'width=device-width, initial-scale=1'
    if (!existing) document.head.appendChild(viewport)
    return () => {
      if (!existing) viewport.remove()
      else if (previousContent === null) viewport.removeAttribute('content')
      else viewport.content = previousContent
    }
  }, [])
  if (loading) return <section className="card" role="status">Conferindo acesso...</section>
  if (!canReadLabels) return <section className="card"><h2>Acesso restrito</h2><p>O leitor de etiquetas não está liberado para esta conta. Um administrador pode liberar em Configurações.</p></section>
  return <Suspense fallback={<section className="card">Carregando leitor...</section>}><LabelReader /></Suspense>
}
