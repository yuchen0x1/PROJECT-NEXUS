import { afterEach, describe, expect, it } from 'vitest'
import { listDraftProviderModels } from '../../server/services/provider-models.mjs'
import { cleanupTestEnvironment, startHttpServer } from './helpers/server-harness.mjs'

afterEach(cleanupTestEnvironment)
const draft = (baseUrl, extra = {}) => ({ kind: 'openai-compatible', baseUrl, apiKey: 'fixture-model-key', ...extra })

describe('read-only provider model discovery', () => {
  it('lists draft models without a saved provider or default model; deduplicates and bounds identifiers', async () => {
    const base = await startHttpServer((req, res) => {
      expect(req.method).toBe('GET')
      expect(req.url).toBe('/gateway/v1/models')
      expect(req.headers.authorization).toBe('Bearer fixture-model-key')
      res.end(JSON.stringify({ data: [{ id: 'zeta' }, { id: 'alpha' }, { id: 'alpha' }, { id: '' }, { id: 'a'.repeat(201) }, null] }))
    })
    const result = await listDraftProviderModels(draft(`${base}/gateway/v1/`))
    expect(result).toEqual({ ok: true, models: [{ id: 'alpha' }, { id: 'zeta' }], truncated: false })
    expect(JSON.stringify(result)).not.toContain('fixture-model-key')
  })

  it('uses a saved key only at its original URL and protocol', async () => {
    let received = 0, keyReads = 0
    const base = await startHttpServer((req, res) => {
      received++
      expect(req.headers.authorization).toBe('Bearer saved-key')
      res.end('{"data":[{"id":"saved-model"}]}')
    })
    const options = { records: [{ id: 'saved', kind: 'openai-compatible', baseUrl: `${base}/v1` }], getSavedKey: async () => { keyReads++; return 'saved-key' } }
    expect((await listDraftProviderModels(draft(`${base}/v1/`, { apiKey: '', providerId: 'saved' }), options)).ok).toBe(true)
    for (const extra of [{ baseUrl: `${base}/different` }, { kind: 'anthropic' }, { providerId: 'missing' }]) {
      expect((await listDraftProviderModels(draft(`${base}/v1`, { apiKey: '', providerId: 'saved', ...extra }), options)).errorCode).toBe('key-required')
    }
    expect(keyReads).toBe(1)
    expect(received).toBe(1)
  })

  it('does not follow redirects containing credential headers', async () => {
    let forwarded = false
    const target = await startHttpServer((req, res) => { forwarded = true; res.end('{"data":[]}') })
    const base = await startHttpServer((req, res) => { res.writeHead(302, { location: `${target}/v1/models` }); res.end() })
    expect((await listDraftProviderModels(draft(base))).errorCode).toBe('network-error')
    expect(forwarded).toBe(false)
  })

  it('rejects nonlocal plaintext URLs, URL credentials and invalid keys before a request', async () => {
    for (const base of ['http://example.com', 'https://user:secret@example.com', 'https://example.com?key=secret', 'https://example.com#fragment', 'bad url']) {
      expect((await listDraftProviderModels(draft(base))).errorCode).toBe('invalid-url')
    }
    expect((await listDraftProviderModels(draft('https://example.com', { apiKey: 'key\nheader' }))).errorCode).toBe('invalid-key')
    expect((await listDraftProviderModels(draft('https://example.com', { apiKey: '' }))).errorCode).toBe('key-required')
    expect((await listDraftProviderModels(draft('https://example.com', { kind: 'arbitrary' }))).errorCode).toBe('invalid-kind')
  })

  it.each([[401, 'unauthorized'], [403, 'unauthorized'], [404, 'unsupported'], [429, 'rate-limit'], [503, 'http-error']])('reports HTTP %i without returning the provider body', async (status, code) => {
    const base = await startHttpServer((req, res) => { res.statusCode = status; res.end('{"error":"echo fixture-model-key"}') })
    const result = await listDraftProviderModels(draft(base))
    expect(result.errorCode).toBe(code)
    expect(result.httpStatus).toBe(status)
    expect(JSON.stringify(result)).not.toContain('fixture-model-key')
  })

  it('rejects invalid and oversized responses; reports empty valid lists', async () => {
    let response = 'not JSON'
    const base = await startHttpServer((req, res) => res.end(response))
    expect((await listDraftProviderModels(draft(base))).errorCode).toBe('invalid-response')
    response = '{}'
    expect((await listDraftProviderModels(draft(base))).errorCode).toBe('invalid-response')
    response = JSON.stringify({ data: [], padding: 'a'.repeat(1024 * 1024) })
    expect((await listDraftProviderModels(draft(base))).errorCode).toBe('response-too-large')
    response = '{"data":[]}'
    expect((await listDraftProviderModels(draft(base))).models).toEqual([])
  })

  it('times out while reading a slow response body', async () => {
    const base = await startHttpServer((req, res) => { res.writeHead(200); res.write('{"data":[') })
    expect((await listDraftProviderModels(draft(base), { timeoutMs: 80 })).errorCode).toBe('timeout')
  })

  it('paginates Anthropic with its native headers', async () => {
    let requests = 0
    const base = await startHttpServer((req, res) => {
      expect(req.headers['x-api-key']).toBe('fixture-model-key')
      expect(req.headers['anthropic-version']).toBe('2023-06-01')
      requests++
      const second = req.url.includes('after_id=first')
      res.end(JSON.stringify({ data: [{ id: second ? 'second' : 'first' }], has_more: !second, last_id: second ? 'second' : 'first' }))
    })
    expect((await listDraftProviderModels(draft(base, { kind: 'anthropic' }))).models).toEqual([{ id: 'first' }, { id: 'second' }])
    expect(requests).toBe(2)
  })

  it('paginates Gemini, keeps keys out of URLs and filters embedding-only models', async () => {
    const base = await startHttpServer((req, res) => {
      expect(req.headers['x-goog-api-key']).toBe('fixture-model-key')
      expect(req.url).not.toContain('key=')
      const second = req.url.includes('pageToken=next')
      res.end(JSON.stringify({ models: second ? [{ name: 'models/text-model', supportedGenerationMethods: ['generateContent'] }] : [{ name: 'models/embed-model', supportedGenerationMethods: ['embedContent'] }], ...(!second ? { nextPageToken: 'next' } : {}) }))
    })
    expect((await listDraftProviderModels(draft(`${base}/v1`, { kind: 'gemini' }))).models).toEqual([{ id: 'text-model' }])
  })

  it('caps results and detects repeated pagination cursors', async () => {
    let repeatCursor = false
    const base = await startHttpServer((req, res) => res.end(JSON.stringify(repeatCursor ? { data: [{ id: 'model' }], has_more: true, last_id: 'same' } : { data: Array.from({ length: 501 }, (_, i) => ({ id: `model-${i}` })) })))
    const result = await listDraftProviderModels(draft(base))
    expect(result.models).toHaveLength(500)
    expect(result.truncated).toBe(true)
    repeatCursor = true
    expect((await listDraftProviderModels(draft(base, { kind: 'anthropic' }))).errorCode).toBe('invalid-response')
  })
})
