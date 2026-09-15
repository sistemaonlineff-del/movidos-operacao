import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './lib/supabase'
import { findLabelMatches, postalCodes } from './labelMatching'
import type { LabelBase } from './labelMatching'
import type { LabelMatch } from './labelMatching'
import './label-reader.css'
import { addressFields, addressLabels, extractionQuery, parseLabelExtraction } from './labelExtraction'
import type { LabelExtraction } from './labelExtraction'
import LabelBatchReader from './LabelBatchReader'

const READ_MAX_EDGE = 1600
const READ_JPEG_QUALITY = 0.75

export default function LabelReader() {
  const [base, setBase] = useState<LabelBase | null>(null)
  const [baseError, setBaseError] = useState('')
  const [retry, setRetry] = useState(0)
  const [photo, setPhoto] = useState('')
  const [query, setQuery] = useState('')
  const [detected, setDetected] = useState(false)
  const [readDone, setReadDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [routeSave, setRouteSave] = useState('')
  const [camera, setCamera] = useState(false)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraStarting, setCameraStarting] = useState(false)
  const [extraction, setExtraction] = useState<LabelExtraction | null>(null)
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const alive = useRef(true)
  const runId = useRef(0)
  const operation = useRef(false)
  const scanKey = useRef('')
  const matches = useMemo(() => findLabelMatches(query, base?.records ?? []), [query, base])
  const primaryMatch = matches.length === 1 ? matches[0] : null
  const ceps = postalCodes(query)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false; runId.current++
      streamRef.current?.getTracks().forEach(track => track.stop())
      requestRef.current?.abort()
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setBaseError(''); setBase(null)
    void (async () => {
      try {
        const { data } = await supabase!.auth.getSession()
        const response = await fetch('/api/label-routes', { headers: { Authorization: `Bearer ${data.session?.access_token ?? ''}` }, signal: controller.signal, cache: 'no-store' })
        if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('O serviço do leitor não está disponível neste ambiente.')
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Não foi possível carregar a base.')
        if (!Array.isArray(result.records)) throw new Error('A base recebida é inválida.')
        if (!controller.signal.aborted) setBase(result)
        const statusResponse = await fetch('/api/label-read', { headers: { Authorization: `Bearer ${data.session?.access_token ?? ''}` }, signal: controller.signal, cache: 'no-store' })
        if (!statusResponse.ok) throw new Error('Não foi possível conferir a leitura automática. Atualize a página para tentar novamente.')
        const status = await statusResponse.json()
        if (!controller.signal.aborted) setAiConfigured(status.configured === true)
      } catch (err) {
        if (!controller.signal.aborted) { setAiConfigured(false); setBaseError(err instanceof Error ? err.message : 'Falha ao carregar a base.') }
      }
    })()
    return () => controller.abort()
  }, [retry])
  useEffect(() => {
    if (camera && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current
      void videoRef.current.play().catch(() => setError('Não foi possível exibir a câmera. Envie uma foto para continuar.'))
    }
  }, [camera])

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach(track => track.stop())
    try { (screen.orientation as any)?.unlock?.() } catch { /* navegador sem controle de orientação */ }
    streamRef.current = null; setCamera(false); setCameraReady(false)
  }
  const startCamera = async () => {
    setError(''); setCameraStarting(true)
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Câmera indisponível neste navegador. Envie uma foto para continuar.')
      try { void (screen.orientation as any)?.lock?.('landscape')?.catch?.(() => {}) } catch { /* em alguns celulares basta girar o aparelho */ }
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, aspectRatio: { ideal: 16 / 9 } }, audio: false })
      if (!alive.current) { stream.getTracks().forEach(track => track.stop()); return }
      streamRef.current = stream; setCamera(true)
    } catch (err) {
      setError(err instanceof DOMException && err.name === 'NotAllowedError' ? 'Acesso à câmera não permitido. Libere a câmera no navegador ou envie uma foto.' : err instanceof Error ? err.message : 'Não foi possível abrir a câmera.')
    } finally { if (alive.current) setCameraStarting(false) }
  }
  const clearReading = () => { setQuery(''); setDetected(false); setReadDone(false); setError(''); setRouteSave(''); setExtraction(null) }
  const newScanKey = () => { scanKey.current = typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}` }
  const canStoreAutomatically = (found: LabelMatch[]) => found.length === 1 && found[0].streetMatch && !found[0].warnings.some(warning => /nome aproximado|bairro divergente|rua não confirmada|cep lido é diferente/i.test(warning))
  const saveInRoute = async (match: LabelMatch, id: number) => {
    if (!scanKey.current) return
    setRouteSave('Adicionando à pré-rota...')
    try {
      const { data } = await supabase!.auth.getSession()
      const response = await fetch('/api/label-volume', { method: 'POST', headers: { Authorization: `Bearer ${data.session?.access_token ?? ''}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ baseId: String(match.record.id), scanKey: scanKey.current }), cache: 'no-store' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Não foi possível adicionar o volume à pré-rota.')
      if (alive.current && id === runId.current) setRouteSave(`${result.duplicate ? 'Já estava' : 'Adicionado'} na pré-rota: ${result.zone} · Rota ${result.route}${result.sequence ? ` · Sequência ${result.sequence}` : ''} · Lote ${result.batch}.`)
    } catch (err) {
      if (alive.current && id === runId.current) setRouteSave(err instanceof Error ? err.message : 'Não foi possível adicionar o volume à pré-rota.')
    }
  }
  const recognize = async (image: string, id: number, prepared = false) => {
    const controller = new AbortController(); requestRef.current = controller
    const timeout = setTimeout(() => controller.abort(), 38000)
    try {
      setProgress('Lendo a etiqueta...')
      const { data } = await supabase!.auth.getSession()
      let upload = image
      if (!prepared) {
        const photoImage = new Image(); photoImage.src = image; await photoImage.decode()
        const canvas = document.createElement('canvas')
        let scale = Math.min(1, READ_MAX_EDGE / Math.max(photoImage.width, photoImage.height))
        for (let attempt = 0; attempt < 4; attempt++) {
          canvas.width = Math.round(photoImage.width * scale); canvas.height = Math.round(photoImage.height * scale)
          const context = canvas.getContext('2d')!; context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(photoImage, 0, 0, canvas.width, canvas.height)
          upload = canvas.toDataURL('image/jpeg', READ_JPEG_QUALITY)
          if (upload.length <= 1_250_000) break
          scale *= 0.78
        }
      }
      if (!alive.current || id !== runId.current || controller.signal.aborted) return
      const response = await fetch('/api/label-read', { method: 'POST', headers: { Authorization: `Bearer ${data.session?.access_token ?? ''}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ image: upload }), signal: controller.signal, cache: 'no-store' })
      if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('O serviço de leitura está indisponível. Tente novamente mais tarde.')
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Não foi possível ler a etiqueta.')
      const reading = parseLabelExtraction(result.extraction)
      if (!alive.current || id !== runId.current) return
      const address = extractionQuery(reading)
      setExtraction(reading); setQuery(address); setDetected(Boolean(address)); setReadDone(true)
      if (address && !camera) setPhoto('')
      if (!address) setError('Não foi possível identificar o endereço. Fotografe a etiqueta de perto e com boa iluminação.')
      const found = findLabelMatches(address, base?.records ?? [])
      if (canStoreAutomatically(found)) void saveInRoute(found[0], id)
      else if (found.length) setRouteSave('Confira o resultado antes de adicionar: a leitura não confirmou um único endereço com segurança.')
    } catch (err) {
      if (alive.current && id === runId.current) setError(controller.signal.aborted ? 'A leitura demorou demais. Tente novamente.' : err instanceof Error ? err.message : 'Não foi possível ler a etiqueta.')
    } finally {
      clearTimeout(timeout)
      if (requestRef.current === controller) requestRef.current = null
      if (alive.current && id === runId.current) { setBusy(false); setProgress(''); operation.current = false }
    }
  }
  const loadPhoto = async (file?: File) => {
    if (!file || operation.current) return
    clearReading()
    if (!/^image\/(jpeg|png|webp|bmp)$/i.test(file.type)) { setError('Envie uma imagem JPG, PNG, WEBP ou BMP.'); return }
    if (file.size > 20 * 1024 * 1024) { setError('A foto deve ter no máximo 20 MB.'); return }
    stopCamera(); newScanKey(); operation.current = true; setBusy(true); setPhoto(''); setProgress('Abrindo foto...')
    const id = ++runId.current
    const url = URL.createObjectURL(file)
    try {
      const image = new Image(); image.src = url; await image.decode()
      const canvas = document.createElement('canvas')
      const scale = Math.min(1, READ_MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight))
      canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale)
      const context = canvas.getContext('2d')!
      context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const data = canvas.toDataURL('image/jpeg', READ_JPEG_QUALITY)
      if (!alive.current || id !== runId.current) return
      setPhoto(data); await recognize(data, id, true)
    } catch {
      if (alive.current && id === runId.current) { setError('Não foi possível abrir essa imagem. Tente um JPG ou PNG.'); setBusy(false); operation.current = false }
    } finally { URL.revokeObjectURL(url) }
  }
  const capture = () => {
    const video = videoRef.current
    if (!video?.videoWidth || operation.current) return
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, READ_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight))
    canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale)
    canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height)
    const data = canvas.toDataURL('image/jpeg', READ_JPEG_QUALITY)
    clearReading(); newScanKey(); operation.current = true; setBusy(true)
    void recognize(data, ++runId.current, true)
  }
  const rotate = async () => {
    if (!photo || operation.current) return
    operation.current = true; setBusy(true); clearReading()
    const id = ++runId.current
    try {
      const image = new Image(); image.src = photo; await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = image.height; canvas.height = image.width
      const context = canvas.getContext('2d')!; context.translate(canvas.width, 0); context.rotate(Math.PI / 2); context.drawImage(image, 0, 0)
      const data = canvas.toDataURL('image/jpeg', READ_JPEG_QUALITY); setPhoto(data); await recognize(data, id, true)
    } catch { if (alive.current) { operation.current = false; setBusy(false); setError('Não foi possível girar a imagem.') } }
  }
  const cancel = () => {
    runId.current++; requestRef.current?.abort(); requestRef.current = null; operation.current = false; setBusy(false); setProgress(''); setError('Leitura cancelada. Você pode enviar outra foto.')
  }

  if (!base) return <section className="card label-reader">{baseError ? <><p role="alert">{baseError}</p><button onClick={() => setRetry(value => value + 1)}>Tentar novamente</button></> : <p role="status">Carregando base e conferindo acesso...</p>}</section>
  return <div className="label-reader">
    <section className="card label-intro"><span className="label-badge">TESTE PRIVADO</span><h2>Leia a etiqueta e consulte a base</h2><p>Fotografe de perto, com o endereço inteiro e boa iluminação. A leitura traz rua, bairro, cidade e CEP para localizar a rota.</p><p className="label-muted">Base: {base.records.length} registros · {[...new Set(base.records.map(record => record.city))].join(' · ')}.</p></section>
    {aiConfigured !== true && <section className="card" role="status"><h3>{aiConfigured === null ? 'Preparando leitura...' : 'Leitura automática indisponível'}</h3><p>{baseError || 'A consulta digitada à base continua disponível.'}</p><button onClick={() => { setAiConfigured(null); setRetry(value => value + 1) }}>Tentar novamente</button></section>}
    <LabelBatchReader base={base} />
    <div className="label-grid">
      <section className="card"><h3>1. Foto da etiqueta</h3>{!camera && <div className="label-actions">
        <button className="primary" onClick={() => void startCamera()} disabled={busy || cameraStarting || aiConfigured !== true}>{cameraStarting ? 'Abrindo...' : 'Abrir leitura contínua'}</button>
        <label className={`label-file ${busy ? 'disabled' : ''}`}>Enviar foto<input aria-label="Enviar foto" type="file" accept="image/jpeg,image/png,image/webp,image/bmp" disabled={busy || aiConfigured !== true} onChange={event => { void loadPhoto(event.target.files?.[0]); event.target.value = '' }} /></label>
      </div>}
      {camera && <div><div className="label-camera-frame"><video ref={videoRef} autoPlay muted playsInline onLoadedData={() => setCameraReady(true)} aria-label="Câmera da etiqueta" /><span>Use o celular deitado e enquadre somente a etiqueta</span></div><div className="label-actions"><button className="primary" onClick={capture} disabled={!cameraReady || busy}>{busy ? 'Lendo...' : 'Capturar e ler'}</button><button onClick={stopCamera}>Fechar câmera</button></div>{readDone && !busy && <p className="camera-ready">Câmera pronta para a próxima etiqueta.</p>}</div>}
      {!camera && (photo ? <img className="label-photo" src={photo} alt="Etiqueta selecionada para leitura" /> : <div className="label-placeholder">A foto da etiqueta aparecerá aqui.</div>)}
      {photo && !camera && <div className="label-actions"><button disabled={busy} onClick={() => void rotate()}>Girar 90° e reler</button><button disabled={busy} onClick={() => { if (operation.current) return; operation.current = true; setBusy(true); clearReading(); void recognize(photo, ++runId.current) }}>Ler novamente</button><button disabled={busy} onClick={() => { clearReading(); setPhoto('') }}>Limpar etiqueta</button></div>}
      {busy && <div className="label-progress" role="status"><p>{progress}</p><button onClick={cancel}>Cancelar leitura</button></div>}
      {error && <p className="label-warning" role="alert">{error}</p>}
      </section>
      <section className="card label-destination"><h3>2. Destino</h3>
        {primaryMatch && <div className="label-route-now"><div><span>Zona</span><strong>{primaryMatch.record.zone || primaryMatch.record.region || 'Não informada'}</strong></div><div><span>Rota</span><strong>{primaryMatch.record.route || 'A definir'}</strong></div>{primaryMatch.record.deliverySequence && <div className="label-route-sequence"><span>Sequência de entrega</span><strong>{primaryMatch.record.deliverySequence}</strong></div>}{routeSave && <p>{routeSave}</p>}</div>}
        {(readDone || query.trim()) && !primaryMatch && <p className="label-zone-missing">Zona não encontrada</p>}
        {matches.length > 1 && <p className="label-warning label-desktop-detail">Há {matches.length} possibilidades. Confira o endereço antes de separar.</p>}
        <div className={primaryMatch ? 'label-address-review single-address' : 'label-address-review'}>{extraction && <><dl className="label-clean-fields">{addressFields.map(field => <div key={field}><dt>{addressLabels[field]}</dt><dd>{extraction.recipient[field] || 'Não identificado'}{extraction.uncertainFields.includes(`recipient.${field}`) && ' — conferir'}</dd></div>)}</dl>{extraction.warnings.map((warning, index) => <p className="label-warning" key={index}>{warning}</p>)}{extraction.uncertainFields.length > 0 && <p className="label-warning">Há campos incertos. Eles não foram usados na consulta automática; confira a foto e corrija o endereço abaixo.</p>}</>}
        <label>Endereço do destinatário para consultar<textarea aria-label="Endereço do destinatário para consultar" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} placeholder="Você também pode digitar ou colar rua, bairro, cidade e CEP para consultar a base." /></label>
        {readDone && !detected && <p className="label-warning">Não identifiquei o endereço. Confira a foto e digite apenas o endereço de entrega acima.</p>}
        <p className="label-muted">Você pode corrigir o endereço acima antes de consultar a base.</p>
        {ceps.length > 0 && <p>CEPs no texto da consulta: <strong>{ceps.join(', ')}</strong></p>}</div>
      </section>
    </div>
    <section className={`card label-route-details ${primaryMatch ? 'single-result' : ''}`}><h3>3. Zona e rota encontradas</h3>
      {!query.trim() ? <p>Leia uma etiqueta ou informe o endereço para consultar.</p> : matches.length === 0 ? <p className="label-warning" role="status">Nenhum registro encontrado nesta base. Confira a leitura e se o endereço pertence às cidades e aos bairros cadastrados. A etiqueta pode ter sido lida corretamente e estar fora da base.</p> : <><p role="status">{matches.length} registro(s) encontrado(s). Confira o destino antes de separar o pacote.</p>{matches.length > 1 && <p className="label-warning">Há mais de uma possibilidade. Compare rua, bairro, CEP e cidade; o primeiro resultado não é uma confirmação automática.</p>}<div className="label-results">{matches.map(({ record, reasons, warnings }) => <article className="label-result" key={record.id}><h4>{record.zone || record.region || 'Zona não informada'} · Rota {record.route || 'A definir'}</h4><p className="label-muted">Zona, rota e sequência conforme a planilha recebida.</p><dl><dt>Zona</dt><dd>{record.zone || record.region || 'Não informada na base'}</dd><dt>Rota</dt><dd>{record.route || 'A definir'}</dd><dt>Sequência</dt><dd>{record.deliverySequence || 'Não informada'}</dd><dt>Rua / Logradouro</dt><dd>{record.street}</dd><dt>Bairro</dt><dd>{record.neighborhood}</dd><dt>CEP</dt><dd>{record.postalCode}</dd><dt>Cidade</dt><dd>{record.city}</dd></dl><p className="label-reasons">{reasons.join(' · ')}</p>{warnings.map(warning => <p className="label-warning" key={warning}>{warning}</p>)}</article>)}</div></>}
    </section>
    <details className="card"><summary>Ver base completa ({base.records.length} registros)</summary><p className="label-muted">Arquivos: {base.source}. Dados importados como recebidos, sem validação cadastral externa.</p><div className="label-table-wrap"><table><thead><tr><th>Região / ROTA</th><th>Rua / Logradouro</th><th>Bairro</th><th>CEP</th><th>Cidade</th><th>Localização no Maps</th><th>Rota no Maps</th><th>Arquivo de origem</th></tr></thead><tbody>{base.records.map(record => <tr key={record.id}><td>{record.region || 'Não informada'}</td><td>{record.street}</td><td>{record.neighborhood}</td><td>{record.postalCode}</td><td>{record.city}</td><td>{record.mapsUrl ? <a href={record.mapsUrl} target="_blank" rel="noreferrer">Abrir no Maps</a> : 'Não informado'}</td><td>{record.routeUrl ? <a href={record.routeUrl} target="_blank" rel="noreferrer">Traçar rota</a> : 'Não informado'}</td><td>{record.sourceFile}</td></tr>)}</tbody></table></div><h4>Resumos dos arquivos originais</h4>{base.summary.map((row, index) => <p key={index}>{Object.entries(row).map(([key, value]) => `${key}: ${value}`).join(' · ')}</p>)}</details>
  </div>
}
