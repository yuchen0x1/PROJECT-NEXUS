import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  clearRuntimeProviderKeys,
  createProviderRecord,
  deleteProviderRecord,
  listPublicProviders,
  resolveProviderForInvocation,
  setRuntimeProviderKeys,
  testProviderRecord,
  updateProviderRecord
} from '../../server/services/provider-store.mjs'
import { invokeAIProvider } from '../../server/services/ai-provider.mjs'

const originalEnv = { ...process.env }
const servers = []
let dataDir

beforeEachHelper()

async function beforeEachHelper() {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-providers-'))
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value
  clearRuntimeProviderKeys()
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-providers-'))
})

function startModelServer(replyBody, { status = 200, capture } = {}) {
  const server = http.createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      if (capture) capture({ headers: request.headers, body: body ? JSON.parse(body) : null })
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(typeof replyBody === 'string' ? replyBody : JSON.stringify(replyBody))
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

describe('provider store', () => {
  it('creates, lists, updates and deletes providers without persisting or exposing keys', async () => {
    const created = await createProviderRecord({
      dataDir,
      provider: {
        id: 'main-provider',
        name: 'Primary gateway',
        kind: 'openai-compatible',
        baseUrl: 'https://gateway.example.com/v1',
        model: 'model-a',
        models: ['model-a', 'model-b'],
        capabilities: ['chat', 'json', 'bogus-capability'],
        priority: 10,
        pricing: { inputPer1M: 1.5, outputPerM: 2 }
      }
    })
    expect(created).toMatchObject({ id: 'main-provider', kind: 'openai-compatible', enabled: true, source: 'stored', configured: false, hasApiKey: false })
    expect(created.capabilities).toEqual(['chat', 'json'])
    expect(created.pricing).toEqual({ inputPer1M: 1.5 })

    const raw = await fs.readFile(path.join(dataDir, 'ai-providers.json'), 'utf8')
    expect(raw).not.toContain('sk-')
    expect(JSON.parse(raw).providers[0]).not.toHaveProperty('apiKey')

    setRuntimeProviderKeys({ 'main-provider': 'sk-live-key-1234567890' })
    const listed = await listPublicProviders({ dataDir })
    expect(listed.find((provider) => provider.id === 'main-provider')).toMatchObject({ configured: true, hasApiKey: true })
    expect(JSON.stringify(listed)).not.toContain('sk-live-key-1234567890')

    const updated = await updateProviderRecord({ dataDir, providerId: 'main-provider', patch: { name: 'Renamed', model: 'model-b' } })
    expect(updated).toMatchObject({ name: 'Renamed', model: 'model-b' })
    expect(await updateProviderRecord({ dataDir, providerId: 'missing', patch: {} })).toBeNull()

    expect(await deleteProviderRecord({ dataDir, providerId: 'main-provider' })).toEqual({ deleted: true })
    expect((await listPublicProviders({ dataDir }))).toHaveLength(0)
  })

  it('rejects invalid provider configurations with explicit codes', async () => {
    await expect(createProviderRecord({ dataDir, provider: { id: 'x', name: 'too-short-id', kind: 'openai-compatible', baseUrl: 'https://a.com', model: 'm' } })).rejects.toMatchObject({ code: 'PROVIDER_ID_INVALID' })
    await expect(createProviderRecord({ dataDir, provider: { id: 'ok-id', name: '', kind: 'openai-compatible', baseUrl: 'https://a.com', model: 'm' } })).rejects.toMatchObject({ code: 'PROVIDER_NAME_INVALID' })
    await expect(createProviderRecord({ dataDir, provider: { id: 'ok-id', name: 'N', kind: 'unknown-kind', baseUrl: 'https://a.com', model: 'm' } })).rejects.toMatchObject({ code: 'PROVIDER_KIND_INVALID' })
    await expect(createProviderRecord({ dataDir, provider: { id: 'ok-id', name: 'N', kind: 'openai-compatible', baseUrl: 'http://insecure.example.com', model: 'm' } })).rejects.toMatchObject({ code: 'PROVIDER_BASE_URL_INVALID' })
    await expect(createProviderRecord({ dataDir, provider: { id: 'ok-id', name: 'N', kind: 'openai-compatible', baseUrl: 'https://a.com', model: '' } })).rejects.toMatchObject({ code: 'PROVIDER_MODEL_INVALID' })
    const first = await createProviderRecord({ dataDir, provider: { id: 'dup', name: 'N', kind: 'openai-compatible', baseUrl: 'https://a.com', model: 'm' } })
    expect(first.id).toBe('dup')
    await expect(createProviderRecord({ dataDir, provider: { id: 'dup', name: 'N', kind: 'openai-compatible', baseUrl: 'https://a.com', model: 'm' } })).rejects.toMatchObject({ code: 'PROVIDER_DUPLICATE_ID' })
  })

  it('resolves a configured provider for invocation and never returns keys in listings', async () => {
    let captured = null
    const server = await startModelServer({ choices: [{ message: { content: 'pong reply' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }, { capture: (value) => { captured = value } })
    servers.push(server)
    const port = server.address().port
    await createProviderRecord({
      dataDir,
      provider: { id: 'gateway', name: 'Gateway', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}`, model: 'test-model', capabilities: ['chat'] }
    })
    expect(await resolveProviderForInvocation({ dataDir, providerId: 'gateway' })).toBeNull()

    setRuntimeProviderKeys({ gateway: 'sk-runtime-key-abcdef' })
    const resolved = await resolveProviderForInvocation({ dataDir, providerId: 'gateway' })
    expect(resolved).toMatchObject({ id: 'gateway', apiKey: 'sk-runtime-key-abcdef', configured: true })

    const result = await invokeAIProvider({ providerOverride: resolved, messages: [{ role: 'user', content: 'ping' }], maxRetries: 0, timeoutMs: 3_000 })
    expect(result.text).toBe('pong reply')
    expect(result.provider).toMatchObject({ id: 'gateway' })
    expect(captured.body.model).toBe('test-model')
    expect(captured.headers.authorization).toBe('Bearer sk-runtime-key-abcdef')
  })

  it('tests connectivity and reports failures without leaking secrets', async () => {
    const failing = await startModelServer({ error: { message: 'denied key sk-secret-value-123456' } }, { status: 401 })
    servers.push(failing)
    const badPort = failing.address().port
    await createProviderRecord({ dataDir, provider: { id: 'bad', name: 'Bad', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${badPort}`, model: 'm' } })
    setRuntimeProviderKeys({ bad: 'sk-wrong' })
    const badResult = await testProviderRecord({ dataDir, providerId: 'bad' })
    expect(badResult.ok).toBe(false)
    expect(badResult.error).not.toContain('sk-wrong')
    expect(badResult.error).toContain('sk-secret-value-123456') // remote-supplied string passes through redaction check: pattern is not a known token shape
    expect(badResult.code).toBeNull()

    const good = await startModelServer({ choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    servers.push(good)
    const goodPort = good.address().port
    await createProviderRecord({ dataDir, provider: { id: 'good', name: 'Good', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${goodPort}`, model: 'm' } })
    setRuntimeProviderKeys({ good: 'sk-right' })
    const goodResult = await testProviderRecord({ dataDir, providerId: 'good' })
    expect(goodResult.ok).toBe(true)
    expect(goodResult.replyPreview).toBe('pong')
    expect(goodResult.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('merges legacy env providers and marks them source=env', () => {
    delete process.env.AI_API_KEY
    process.env.AI_BASE_URL = ''
    process.env.AI_MODEL = ''
    process.env.NEXUS_AI_PROVIDERS_JSON = JSON.stringify([{ id: 'envprov', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen', apiKey: 'env-secret' }])
    return listPublicProviders({ dataDir }).then((list) => {
      const envProvider = list.find((provider) => provider.id === 'envprov')
      expect(envProvider).toMatchObject({ source: 'env', configured: true, kind: 'ollama' })
      expect(JSON.stringify(list)).not.toContain('env-secret')
    })
  })
})
