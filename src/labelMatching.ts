export interface LabelRoute {
  id: number | string; street: string; neighborhood: string; postalCode: string; city: string
  mapsUrl: string; routeUrl: string; sourceSheet: string; sourceRow: number; sourceFile?: string; region?: string; zone?: string; route?: string; deliverySequence?: number | null
}
export interface LabelBase { source: string; records: LabelRoute[]; summary: Record<string, string>[] }
export interface LabelMatch { record: LabelRoute; reasons: string[]; warnings: string[]; score: number; streetMatch: boolean }
export const normalizeLabelText = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const contains = (text: string, term: string) => Boolean(term) && ` ${text} `.includes(` ${term} `)
const streetName = (text: string) => normalizeLabelText(text).replace(/^(rua|r|avenida|av|travessa|tr|praca|pca|estrada|est|rodovia|rod) /, '')
const usefulWords = (text: string) => text.split(' ').filter(word => word.length > 2 && !['dos', 'das', 'doutor', 'professor', 'municipal'].includes(word))

export function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + Number(a[i - 1] !== b[j - 1]))
    row = next
  }
  return row[b.length]
}

// Compare a contiguous street phrase, not names scattered across the label.
function phraseSimilarity(expected: string, text: string): number {
  const words = usefulWords(expected), observed = usefulWords(text)
  const compact = words.join('')
  if (compact.length < 8 || words.length < 2) return 0
  let best = 0
  for (let start = 0; start < observed.length; start++) {
    for (let count = Math.max(1, words.length - 1); count <= words.length + 2 && start + count <= observed.length; count++) {
      const part = observed.slice(start, start + count).join('')
      if (Math.abs(part.length - compact.length) > compact.length * 0.28) continue
      best = Math.max(best, 1 - editDistance(compact, part) / Math.max(compact.length, part.length))
    }
  }
  return best
}

export function destinationText(text: string): { text: string; detected: boolean } {
  const start = /destinat[aá]rio\s*:?/i.exec(text)
  if (!start) return { text: '', detected: false }
  const tail = text.slice(start.index + start[0].length)
  const end = /remetente|devolu[cç][aã]o|danfe/i.exec(tail)
  return { text: (end ? tail.slice(0, end.index) : tail).trim(), detected: true }
}

export function postalCodes(text: string): string[] {
  return [...new Set([...text.matchAll(/(?<!\d)(\d{5})[\s.-]?(\d{3})(?!\d)/g)].map(m => `${m[1]}-${m[2]}`))]
}

export function findLabelMatches(text: string, records: LabelRoute[]): LabelMatch[] {
  // Repair a physical line break in a word, e.g. "G\nuararema", for search only.
  const repaired = text.replace(/\b([a-zA-ZÀ-ÿ])\s*\r?\n\s*(?=[a-zà-ÿ])/g, '$1')
  const normalized = normalizeLabelText(repaired)
  if (!normalized) return []
  const ceps = postalCodes(repaired)
  const cepCounts = new Map<string, number>()
  const cityNames = [...new Set(records.map(record => normalizeLabelText(record.city.split(' - ')[0])))]
  const tokens = normalized.split(' ')
  const detectedCities = cityNames.filter(city => contains(normalized, city) || tokens.some((_, index) => tokens.slice(index, index + 2).join('') === city.replace(/ /g, '')))
  const detectedNeighborhoods = [...new Set(records.map(record => normalizeLabelText(record.neighborhood)))].filter(name => contains(normalized, name))
  const streetMarker = /\b(?:rua|r\.|avenida|av\.?|travessa|tr\.|praça|praca|estrada|est\.|rodovia)\s+/i.exec(repaired)
  // End at the house number, keeping recipient names out of street matching.
  const streetScope = normalizeLabelText(streetMarker ? repaired.slice(streetMarker.index + streetMarker[0].length).split(/[,;]|\s\d+(?:\s|,|$)/)[0] : repaired)
  for (const record of records) cepCounts.set(record.postalCode, (cepCounts.get(record.postalCode) ?? 0) + 1)
  const candidates = records.flatMap(record => {
    const cityName = normalizeLabelText(record.city.split(' - ')[0])
    if (detectedCities.length && !detectedCities.includes(cityName)) return []
    const street = streetName(record.street)
    const exactStreet = contains(streetScope, street)
    const similarity = exactStreet ? 1 : phraseSimilarity(street, streetScope)
    const similarStreet = !exactStreet && similarity >= 0.76
    const streetMatch = exactStreet || similarStreet
    const cep = ceps.includes(record.postalCode)
    const neighborhood = contains(normalized, normalizeLabelText(record.neighborhood))
    const city = detectedCities.includes(cityName)
    if (!cep && !streetMatch && !neighborhood) return []
    const reasons = [cep && 'CEP encontrado', exactStreet && 'Rua encontrada', neighborhood && 'Bairro encontrado', city && 'Cidade encontrada', similarStreet && 'Nome de rua semelhante'].filter(Boolean) as string[]
    const warnings: string[] = []
    const sharedCep = cep && (cepCounts.get(record.postalCode) ?? 0) > 1
    if (sharedCep) warnings.push('CEP compartilhado por várias ruas: confira rua e bairro para definir a região.')
    if (ceps.length && !cep) warnings.push('O CEP lido é diferente do CEP deste registro.')
    if (!city) warnings.push('A cidade da base não foi confirmada no texto.')
    if (similarStreet) warnings.push('Nome aproximado: confira a rua na etiqueta.')
    if (detectedNeighborhoods.length && !neighborhood) warnings.push(`Bairro divergente: o texto contém ${detectedNeighborhoods.join(', ')}, mas a base informa ${record.neighborhood}. Confira antes de separar.`)
    if (!streetMatch) warnings.push('Rua não confirmada: CEP ou bairro sozinho não determina o endereço.')
    return [{ record, reasons, warnings, streetMatch, score: (streetMatch ? 200 + Math.round(similarity * 100) : 0) + Number(cep) * (sharedCep ? 5 : 35) + Number(neighborhood) * 20 + Number(city) * 10 }]
  }).sort((a, b) => b.score - a.score || String(a.record.id).localeCompare(String(b.record.id)))
  // Keep competing street readings, not every address with the same general CEP.
  const streetMatches = candidates.filter(candidate => candidate.streetMatch)
  if (streetMatches.length) return streetMatches.filter(candidate => candidate.score >= streetMatches[0].score - 55)
  if (streetMarker) return []
  return candidates
}
