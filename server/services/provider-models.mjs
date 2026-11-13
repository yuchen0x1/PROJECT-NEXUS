// Read-only model discovery. Never persist draft credentials or return provider
// error bodies: gateways may echo secrets in those bodies.
const KINDS = new Set(['openai', 'openai-compatible', 'anthropic', 'gemini', 'ollama'])
const MAX_BYTES = 1024 * 1024
const MAX_MODELS = 500
const MAX_PAGES = 5

function failure(errorCode, httpStatus) {
  return { ok: false, models: [], truncated: false, errorCode, ...(httpStatus ? { httpStatus } : {}) }
}

function normalizedBase(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('invalid-url')
  const url = new URL(value.trim())
  if (url.username || url.password || url.search || url.hash) throw new Error('invalid-url')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('invalid-url')
  return url.toString().replace(/\/+$/, '')
}

function modelsUrl(base, kind) {
  if (kind === 'ollama') return `${base.replace(/\/(?:v1|api)$/, '')}/api/tags`
  if (kind === 'gemini') return `${base.replace(/\/(?:v1|v1beta)$/, '')}/v1beta/models`
  return `${base.replace(/\/v1$/, '')}/v1/models`
}

async function boundedJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new Error('response-too-large')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('invalid-response')
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_BYTES) throw new Error('response-too-large')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/** Resolve a saved key only for the exact saved endpoint and protocol. */
export async function listDraftProviderModels(draft, { records = [], getSavedKey = async () => '', timeoutMs = 15_000 } = {}) {
  if (!draft || typeof draft !== 'object' || !KINDS.has(draft.kind)) return failure('invalid-kind')
  let base
  try { base = normalizedBase(draft.baseUrl) } catch { return failure('invalid-url') }
  if (draft.apiKey != null && (typeof draft.apiKey !== 'string' || draft.apiKey.length > 4096 || /[\r\n]/.test(draft.apiKey))) return failure('invalid-key')
  let apiKey = draft.apiKey?.trim() || ''
  if (!apiKey && draft.providerId) {
    const saved = records.find((item) => item.id === draft.providerId)
    let sameEndpoint = false
    try { sameEndpoint = Boolean(saved && saved.kind === draft.kind && normalizedBase(saved.baseUrl) === base) } catch { /* invalid saved endpoint */ }
    if (!sameEndpoint) return failure('key-required')
    try { apiKey = await getSavedKey(saved) || '' } catch { return failure('key-unavailable') }
  }
  if (!apiKey && draft.kind !== 'ollama') return failure('key-required')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const url = new URL(modelsUrl(base, draft.kind))
    const headers = { accept: 'application/json' }
    if (draft.kind === 'anthropic') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
      url.searchParams.set('limit', '100')
    } else if (draft.kind === 'gemini') {
      headers['x-goog-api-key'] = apiKey
      url.searchParams.set('pageSize', '100')
    } else if (apiKey) headers.authorization = `Bearer ${apiKey}`
    const models = new Map()
    const cursors = new Set()
    let truncated = false
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await fetch(url, { headers, redirect: 'error', signal: controller.signal })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        return failure([404, 405, 501].includes(response.status) ? 'unsupported' : response.status === 401 || response.status === 403 ? 'unauthorized' : response.status === 429 ? 'rate-limit' : 'http-error', response.status)
      }
      let body
      try { body = await boundedJson(response) } catch (error) {
        if (controller.signal.aborted) throw error
        return failure(error.message === 'response-too-large' ? 'response-too-large' : 'invalid-response')
      }
      const entries = draft.kind === 'gemini' || draft.kind === 'ollama' ? body?.models : body?.data
      if (!Array.isArray(entries)) return failure('invalid-response')
      for (const entry of entries) {
        // Gemini also lists embedding-only models, which cannot serve as the
        // default text generation model used by this application.
        if (draft.kind === 'gemini' && Array.isArray(entry?.supportedGenerationMethods) && !entry.supportedGenerationMethods.includes('generateContent')) continue
        const id = draft.kind === 'gemini' ? (typeof entry?.name === 'string' ? entry.name.replace(/^models\//, '') : null) : draft.kind === 'ollama' ? entry?.name : entry?.id
        if (typeof id !== 'string' || !id.trim() || id.length > 200 || /[\x00-\x1f\x7f]/.test(id)) continue
        if (models.size >= MAX_MODELS && !models.has(id)) { truncated = true; break }
        models.set(id, { id })
      }
      const cursor = draft.kind === 'gemini' ? body.nextPageToken : draft.kind === 'anthropic' && body.has_more ? body.last_id : null
      if (draft.kind === 'anthropic' && body.has_more && !cursor) return failure('invalid-response')
      if (!cursor || truncated) break
      if (typeof cursor !== 'string' || cursor.length > 2048 || cursors.has(cursor)) return failure('invalid-response')
      cursors.add(cursor)
      if (page === MAX_PAGES - 1) { truncated = true; break }
      url.searchParams.set(draft.kind === 'gemini' ? 'pageToken' : 'after_id', cursor)
    }
    return { ok: true, models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)), truncated }
  } catch {
    return failure(controller.signal.aborted ? 'timeout' : 'network-error')
  } finally { clearTimeout(timer) }
}
