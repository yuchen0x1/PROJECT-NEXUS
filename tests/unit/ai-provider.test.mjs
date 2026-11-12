import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import { assertTrustedProviderUrl, generateLocalAgentOperations, invokeAIProvider, listAIProviders, normalizeUsage, selectAIProvider } from '../../server/services/ai-provider.mjs'

const originalEnv = { ...process.env }
const servers = []

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value
})

describe('AI provider registry and execution', () => {
  it('normalizes usage and rejects untrusted provider URLs', () => {
    expect(normalizeUsage({ prompt_tokens: 3, completion_tokens: 4 })).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 })
    expect(() => assertTrustedProviderUrl('http://example.com')).toThrow(/HTTPS/)
    expect(assertTrustedProviderUrl('http://127.0.0.1:4317')).toBe('http://127.0.0.1:4317')
  })

  it('routes a task to a configured local provider without exposing its key', async () => {
    let attempts = 0
    const server = http.createServer((request, response) => {
      attempts += 1
      if (attempts === 1) {
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'temporary' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: 'diagnosis result' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const port = server.address().port
    process.env.AI_API_KEY = ''
    process.env.AI_BASE_URL = ''
    process.env.AI_MODEL = ''
    process.env.NEXUS_AI_PROVIDERS_JSON = JSON.stringify([{ id: 'local', kind: 'ollama', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'local-secret', model: 'qwen', priority: 1, pricing: { inputPer1M: 1, outputPer1M: 2 } }])
    process.env.NEXUS_AI_ROUTING_JSON = JSON.stringify({ diagnosis: 'local' })
    const providers = listAIProviders()
    expect(providers.find((provider) => provider.id === 'local')).toMatchObject({ configured: true, host: `127.0.0.1:${port}`, routedTasks: ['diagnosis'] })
    expect(selectAIProvider('diagnosis').id).toBe('local')
    const result = await invokeAIProvider({ taskType: 'diagnosis', messages: [{ role: 'user', content: 'hello' }], maxRetries: 1, timeoutMs: 2_000 })
    expect(result.text).toBe('diagnosis result')
    expect(result.attempts).toBe(2)
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    expect(result.costUsd).toBe(0.00002)
    expect(result.provider).toMatchObject({ id: 'local', host: `127.0.0.1:${port}` })
  })

  it('allows a keyless Ollama provider and falls back from an unconfigured default', () => {
    process.env.AI_API_KEY = ''
    process.env.AI_BASE_URL = ''
    process.env.AI_MODEL = ''
    process.env.AI_DEFAULT_PROVIDER = 'default'
    process.env.NEXUS_AI_PROVIDERS_JSON = JSON.stringify([{ id: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen' }])
    expect(selectAIProvider('analysis')).toMatchObject({ id: 'ollama', configured: true })
    expect(listAIProviders().find((provider) => provider.id === 'ollama')).toMatchObject({ configured: true, default: true })
  })
})

describe('bounded local Agent provider operations', () => {
  async function useProvider(reply) {
    const requests = []
    const server = http.createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        requests.push({ headers: request.headers, body: JSON.parse(body) })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 30, completion_tokens: 15 } }))
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    process.env.AI_API_KEY = ''
    process.env.AI_BASE_URL = ''
    process.env.AI_MODEL = ''
    process.env.NEXUS_AI_PROVIDERS_JSON = JSON.stringify([{ id: 'local-agent', kind: 'ollama', baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'local-secret', model: 'qwen', pricing: { inputPer1M: 1, outputPer1M: 2 } }])
    process.env.NEXUS_AI_ROUTING_JSON = '{}'
    return requests
  }

  const baseInput = {
    prompt: 'Add a small helper and keep the existing public API stable.',
    project: { id: 'project-1', name: 'nexus-demo', path: 'C:\\private\\nexus-demo' },
    sourceFiles: [{ path: 'src/index.mjs', content: 'export const ready = true\n' }]
  }

  it('sends bounded, redacted untrusted context and returns validated operations with provider metadata', async () => {
    const requests = await useProvider(JSON.stringify({
      operations: [{ action: 'replace', path: 'src/index.mjs', content: 'export const ready = true\nexport const count = 1\n' }],
      rationale: 'Add the requested export without changing existing behavior.'
    }))
    const result = await generateLocalAgentOperations({
      ...baseInput,
      prompt: `${baseInput.prompt} api_key=sk-123456789012345678901234567890`,
      project: { ...baseInput.project, name: 'demo password=top-secret' },
      sourceFiles: [
        { path: 'src/index.mjs', content: 'const api_key = "sk-123456789012345678901234567890";\nexport const ready = true\n' },
        { path: '.env', content: 'API_KEY=ghp_123456789012345678901234567890' }
      ],
      providerId: 'local-agent'
    })

    expect(requests).toHaveLength(1)
    const serializedRequest = JSON.stringify(requests[0].body)
    expect(serializedRequest).not.toContain('C:\\private\\nexus-demo')
    expect(serializedRequest).not.toContain('sk-123456789012345678901234567890')
    expect(serializedRequest).not.toContain('ghp_123456789012345678901234567890')
    expect(serializedRequest).toContain('[REDACTED]')
    expect(requests[0].body.response_format).toEqual({ type: 'json_object' })
    expect(requests[0].headers.authorization).toBe('Bearer local-secret')
    expect(result).toMatchObject({
      operations: [{ action: 'replace', path: 'src/index.mjs' }],
      rationale: 'Add the requested export without changing existing behavior.',
      sentPaths: ['src/index.mjs'],
      provider: { id: 'local-agent', kind: 'ollama' },
      providerId: 'local-agent', model: 'qwen',
      usage: { inputTokens: 30, outputTokens: 15, totalTokens: 45 },
      costUsd: 0.00006, attempts: 1
    })
    expect(result.operations[0].content).toContain('count = 1')
  })

  it('rejects prompts, source lists, and serialized requests over their byte limits before making a request', async () => {
    const requests = await useProvider('{"operations":[],"rationale":"none"}')
    await expect(generateLocalAgentOperations({ ...baseInput, prompt: 'x'.repeat(8 * 1024 + 1) })).rejects.toMatchObject({ code: 'AI_INPUT_TOO_LARGE' })
    await expect(generateLocalAgentOperations({ ...baseInput, sourceFiles: Array.from({ length: 21 }, (_, index) => ({ path: `src/${index}.js`, content: '' })) })).rejects.toMatchObject({ code: 'AI_SOURCE_LIMIT' })
    await expect(generateLocalAgentOperations({ ...baseInput, sourceFiles: [{ path: 'src/large.txt', content: 'x'.repeat(120 * 1024) }] })).rejects.toMatchObject({ code: 'AI_SOURCE_LIMIT' })
    await expect(generateLocalAgentOperations({ ...baseInput, sourceFiles: [{ path: 'src/large.txt', content: '\n'.repeat(90 * 1024) }] })).rejects.toMatchObject({ code: 'AI_REQUEST_TOO_LARGE' })
    expect(requests).toHaveLength(0)
  })

  it.each([
    ['delete operation', { operations: [{ action: 'delete', path: 'src/index.mjs', content: '' }], rationale: 'delete it' }],
    ['path traversal', { operations: [{ action: 'replace', path: '../outside.txt', content: 'bad' }], rationale: 'outside' }],
    ['secret path', { operations: [{ action: 'replace', path: 'config/.env.production', content: 'bad' }], rationale: 'secret' }],
    ['command field', { operations: [{ action: 'create', path: 'src/new.mjs', content: '', command: 'whoami' }], rationale: 'command' }],
    ['too many operations', { operations: Array.from({ length: 21 }, (_, index) => ({ action: 'create', path: `src/${index}.mjs`, content: '' })), rationale: 'too many' }],
    ['oversized content', { operations: [{ action: 'create', path: 'src/large.mjs', content: 'x'.repeat(256 * 1024 + 1) }], rationale: 'large' }],
    ['missing rationale', { operations: [] }]
  ])('rejects unsafe model output: %s', async (_label, reply) => {
    await useProvider(JSON.stringify(reply))
    await expect(generateLocalAgentOperations(baseInput)).rejects.toMatchObject({ code: 'AI_INVALID_OPERATIONS' })
  })

  it('rejects non-JSON model output instead of extracting code fences', async () => {
    await useProvider('```json\n{"operations":[],"rationale":"none"}\n```')
    await expect(generateLocalAgentOperations(baseInput)).rejects.toMatchObject({ code: 'AI_INVALID_OPERATIONS' })
  })
})
