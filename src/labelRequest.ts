type LabelRequestOptions = RequestInit & {
  retryNetwork?: boolean
  onRetry?: (attempt: number, delayMs: number) => void
}

const pause = (delayMs: number, signal?: AbortSignal | null) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return }
  const abort = () => { clearTimeout(timer); reject(signal?.reason) }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, delayMs)
  signal?.addEventListener('abort', abort, { once: true })
})

export async function labelRequest(url: string, options: LabelRequestOptions) {
  const { retryNetwork = false, onRetry, ...init } = options
  for (let attempt = 0; attempt < 3; attempt++) {
    init.signal?.throwIfAborted()
    let response: Response
    const controller = new AbortController()
    const abort = () => controller.abort(init.signal?.reason)
    init.signal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => controller.abort(new DOMException('A leitura demorou para responder. Tente novamente.', 'TimeoutError')), 38000)
    try {
      response = await fetch(url, { ...init, signal: controller.signal })
    } catch (error) {
      if (init.signal?.aborted || !retryNetwork || attempt === 2) throw error
      const delayMs = 1000 * 2 ** attempt
      onRetry?.(attempt + 1, delayMs)
      await pause(delayMs, init.signal)
      continue
    } finally {
      clearTimeout(timeout)
      init.signal?.removeEventListener('abort', abort)
    }
    const result = await response.json().catch(() => null)
    if (response.ok && result) return result
    const temporary = result?.retryable !== false && ([429, 502, 504].includes(response.status) || (response.status === 503 && result?.retryable === true))
    if (!temporary || attempt === 2) throw new Error(result?.error || 'O servico do leitor nao respondeu corretamente. Tente novamente.')
    const retryAfter = response.headers.get('Retry-After')
    const requestedDelay = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : retryAfter ? Date.parse(retryAfter) - Date.now() : 0
    const delayMs = Math.max(1000 * 2 ** attempt, Number.isFinite(requestedDelay) ? requestedDelay : 0)
    if (delayMs > 60000) throw new Error(result?.error || 'O limite de leituras foi atingido. Tente novamente mais tarde.')
    onRetry?.(attempt + 1, delayMs)
    await pause(delayMs, init.signal)
  }
  throw new Error('Nao foi possivel concluir a leitura.')
}