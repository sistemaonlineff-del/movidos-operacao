import { useEffect, useId, useMemo, useState } from 'react'

type Municipality = { name: string; state: string }
let municipalitiesRequest: Promise<Municipality[]> | undefined

function loadMunicipalities() {
  if (!municipalitiesRequest) {
    municipalitiesRequest = fetch('/municipalities.json').then(response => {
      if (!response.ok) throw new Error('Não foi possível carregar a lista de municípios.')
      return response.json() as Promise<Municipality[]>
    })
  }
  return municipalitiesRequest
}

export default function MunicipalityInput({ label, value, state, onChange }: { label: string; value: string; state: string; onChange: (value: string) => void }) {
  const id = useId().replace(/:/g, '')
  const [municipalities, setMunicipalities] = useState<Municipality[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    let current = true
    loadMunicipalities().then(rows => { if (current) setMunicipalities(rows) }).catch(caught => { if (current) setError((caught as Error).message) })
    return () => { current = false }
  }, [])

  const options = useMemo(() => municipalities.filter(item => !state || item.state === state), [municipalities, state])
  return <label>
    {label}
    <input aria-label={label} list={`municipalities-${id}`} value={value} onChange={event => onChange(event.target.value.toLocaleUpperCase('pt-BR'))} autoComplete="off" />
    <datalist id={`municipalities-${id}`}>{options.map(item => <option key={`${item.state}-${item.name}`} value={item.name.toLocaleUpperCase('pt-BR')}>{item.state}</option>)}</datalist>
    {error && <small className="field-error">{error}</small>}
  </label>
}
