import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { invokeAIProvider, providerUrl, redactSecrets } from './ai-provider.mjs'

// Persistent, renderer-safe AI provider registry.
// Provider *metadata* is stored in <dataDir>/ai-providers.json. API keys are
// never persisted here: the Electron main process injects decrypted keys into
// this process over the authenticated local API (or NEXUS_AI_PROVIDERS_JSON in
// server deployments), and they live only in process memory.

export const PROVIDER_STORE_FILE = 'ai-providers.json'
export const PROVIDER_STORE_SCHEMA_VERSION = 1
export const MAX_PROVIDERS = 24

export const PROVIDER_KINDS = Object.freeze(['openai', 'openai-compatible', 'ollama', 'anthropic', 'gemini'])
export const PROVIDER_CAPABILITIES = Object.freeze(['chat', 'json', 'tools', 'vision', 'long-context', 'structured-output'])
export const AGENT_TASK_TYPES = Object.freeze([
  'understanding', 'planning', 'coding', 'review', 'error-analysis', 'testing', 'documentation'
])

const KIND_ALIASES = new Map([
  ['openai', 'openai'], ['openai-compatible', 'openai-compatible'], ['ollama', 'ollama'],
  ['anthropic', 'anthropic'], ['claude', 'anthropic'],
  ['gemini', 'gemini'], ['google', 'gemini'], ['google-gemini', 'gemini'],
  ['lm-studio', 'openai-compatible'], ['local', 'openai-compatible'], ['custom', 'openai-compatible']
])

const storeQueues = new Map()

function storeError(code, message) {
  return Object.assign(new Error(message), { code })
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function jsonClone(value, label) {
  let serialized
  try { serialized = JSON.stringify(value) }
  catch (error) { throw storeError('PROVIDER_STORE_INVALID', `${label} must contain only JSON-compatible values: ${error.message}`) }
  try { return JSON.parse(serialized) }
  catch (error) { throw storeError('PROVIDER_STORE_INVALID', `${label} must be JSON-compatible: ${error.message}`) }
}

function validateId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(value)) {
    throw storeError('PROVIDER_ID_INVALID', 'Provider id must be 2-64 lowercase letters, digits, hyphens, or underscores and start with a letter or digit.')
  }
  return value
}

function normalizeKind(value) {
  const key = String(value || 'openai-compatible').toLowerCase().trim()
  return KIND_ALIASES.get(key) || null
}

function normalizeTrustedBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw storeError('PROVIDER_BASE_URL_INVALID', 'A provider base URL is required.')
  let normalized
  try { normalized = providerUrl(value.trim(), 'Provider base URL') }
  catch (error) { throw storeError('PROVIDER_BASE_URL_INVALID', safeMessage(error)) }
  return normalized
}

function normalizeModels(value, primaryModel) {
  const list = Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : []
  if (list.length > 100) throw storeError('PROVIDER_MODELS_INVALID', 'A provider may declare at most 100 models.')
  for (const model of list) {
    if (model.length > 200) throw storeError('PROVIDER_MODELS_INVALID', 'Provider model ids are limited to 200 characters.')
  }
  const merged = primaryModel && !list.includes(primaryModel) ? [primaryModel, ...list] : list
  return merged.slice(0, 100)
}

function normalizeCapabilities(value) {
  const list = Array.isArray(value) ? value.map((item) => String(item || '').toLowerCase().trim()).filter(Boolean) : []
  const known = list.filter((item) => PROVIDER_CAPABILITIES.includes(item))
  return [...new Set(known)]
}

function normalizePricing(value) {
  const source = isPlainObject(value) ? value : {}
  const result = {}
  for (const key of ['inputPer1M', 'outputPer1M']) {
    const number = Number(source[key])
    if (Number.isFinite(number) && number >= 0) result[key] = Number(number.toFixed(8))
  }
  return result
}

function normalizeRouting(value) {
  const source = isPlainObject(value) ? value : {}
  const routing = {}
  for (const taskType of AGENT_TASK_TYPES) {
    const target = source[taskType]
    if (typeof target === 'string' && target) routing[taskType] = target
  }
  return routing
}

function normalizeProvider(input, { requireNew = false } = {}) {
  if (!isPlainObject(input)) throw storeError('PROVIDER_INVALID', 'A provider configuration object is required.')
  const id = requireNew ? validateId(String(input.id || crypto.randomUUID().slice(0, 12)).toLowerCase()) : validateId(String(input.id || ''))
  const name = String(input.name || '').trim()
  if (!name || name.length > 120) throw storeError('PROVIDER_NAME_INVALID', 'Provider name must be 1-120 characters.')
  const kind = normalizeKind(input.kind)
  if (!kind) throw storeError('PROVIDER_KIND_INVALID', `Provider kind must be one of: ${PROVIDER_KINDS.join(', ')}.`)
  const baseUrl = normalizeTrustedBaseUrl(input.baseUrl)
  const model = String(input.model || '').trim()
  if (!model || model.length > 200) throw storeError('PROVIDER_MODEL_INVALID', 'A default model id (1-200 characters) is required.')
  const contextWindow = Number(input.contextWindow)
  const maxOutputTokens = Number(input.maxOutputTokens)
  const temperature = Number(input.temperature)
  const timeoutMs = Number(input.timeoutMs)
  const priority = Number(input.priority ?? 50)
  return {
    id,
    name,
    kind,
    baseUrl,
    model,
    models: normalizeModels(input.models, model),
    contextWindow: Number.isFinite(contextWindow) && contextWindow >= 1024 ? Math.floor(contextWindow) : null,
    maxOutputTokens: Number.isFinite(maxOutputTokens) && maxOutputTokens >= 16 && maxOutputTokens <= 1_000_000 ? Math.floor(maxOutputTokens) : null,
    temperature: Number.isFinite(temperature) && temperature >= 0 && temperature <= 2 ? Number(temperature.toFixed(2)) : 0.2,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 1_000 && timeoutMs <= 600_000 ? Math.floor(timeoutMs) : 120_000,
    priority: Number.isFinite(priority) && priority >= 0 && priority <= 1000 ? Math.floor(priority) : 50,
    capabilities: normalizeCapabilities(input.capabilities),
    pricing: normalizePricing(input.pricing),
    routing: normalizeRouting(input.routing),
    enabled: input.enabled === undefined ? true : Boolean(input.enabled)
  }
}

function resolveStoreFile(dataDir) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) {
    throw storeError('PROVIDER_STORE_INVALID_DATA_DIR', 'dataDir must be an absolute directory path.')
  }
  return path.join(path.resolve(dataDir), PROVIDER_STORE_FILE)
}

async function assertRegularFileOrMissing(file) {
  const stat = await fs.lstat(file).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (stat?.isSymbolicLink() || (stat && !stat.isFile())) {
    throw storeError('PROVIDER_STORE_INVALID_FILE', 'Provider store must be a regular file, not a symbolic link or directory.')
  }
}

async function writeStoreFile(file, document) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await assertRegularFileOrMissing(file)
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(document, null, 2), { encoding: 'utf8', flag: 'wx' })
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

async function loadStore(file) {
  await assertRegularFileOrMissing(file)
  let content
  try { content = await fs.readFile(file, 'utf8') }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { schemaVersion: PROVIDER_STORE_SCHEMA_VERSION, providers: [] }
  }
  let parsed
  try { parsed = JSON.parse(content) }
  catch (error) { throw storeError('PROVIDER_STORE_INVALID', `Provider store is not valid JSON; refusing to replace it: ${error.message}`) }
  if (!isPlainObject(parsed) || parsed.schemaVersion !== PROVIDER_STORE_SCHEMA_VERSION || !Array.isArray(parsed.providers)) {
    throw storeError('PROVIDER_STORE_INVALID', 'Provider store must use schemaVersion 1 and contain a providers array.')
  }
  if (parsed.providers.length > MAX_PROVIDERS) throw storeError('PROVIDER_STORE_LIMIT', `Provider store exceeds the ${MAX_PROVIDERS}-provider limit.`)
  return parsed
}

async function withStoreQueue(file, operation) {
  const resolved = path.resolve(file)
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const previous = storeQueues.get(key) || Promise.resolve()
  let release
  const current = new Promise((resolve) => { release = resolve })
  const queued = previous.catch(() => {}).then(() => current)
  storeQueues.set(key, queued)
  await previous.catch(() => {})
  try { return await operation() }
  finally {
    release()
    if (storeQueues.get(key) === queued) storeQueues.delete(key)
  }
}

// ---- Runtime key store (process memory only) ----

const runtimeKeys = new Map()

export function setRuntimeProviderKeys(keys) {
  if (!isPlainObject(keys)) throw storeError('PROVIDER_KEYS_INVALID', 'Provider keys must be an object of providerId -> apiKey.')
  for (const [id, key] of Object.entries(keys)) {
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(id)) continue
    if (key === null || key === '') runtimeKeys.delete(id.toLowerCase())
    else if (typeof key === 'string' && key.length <= 4096) runtimeKeys.set(id.toLowerCase(), key)
  }
  return { ids: [...runtimeKeys.keys()] }
}

export function clearRuntimeProviderKeys() {
  runtimeKeys.clear()
}

function safeMessage(error) {
  return redactSecrets(String(error?.message || 'Operation failed')).slice(0, 500)
}

// ---- Provider resolution ----

function envProviders() {
  // Inherit the legacy env-configured providers so existing server deployments keep working.
  let raw = null
  const value = process.env.NEXUS_AI_PROVIDERS_JSON
  if (value) {
    try {
      const parsed = JSON.parse(value)
      raw = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray(parsed.providers) ? parsed.providers : null
    } catch { raw = null }
  }
  const extras = Array.isArray(raw) ? raw : []
  const list = []
  const primaryKind = String(process.env.AI_PROVIDER_KIND || 'openai-compatible').toLowerCase()
  if (process.env.AI_BASE_URL && process.env.AI_MODEL) {
    list.push({
      id: 'default',
      name: 'Environment default',
      kind: normalizeKind(primaryKind) || 'openai-compatible',
      baseUrl: process.env.AI_BASE_URL,
      model: process.env.AI_MODEL,
      models: [process.env.AI_MODEL],
      capabilities: ['chat', 'json'],
      priority: 0,
      pricing: {},
      routing: {},
      enabled: true,
      source: 'env'
    })
  }
  extras.forEach((item, index) => {
    if (!isPlainObject(item)) return
    const kind = normalizeKind(item.kind || item.type)
    const baseUrl = typeof item.baseUrl === 'string' ? item.baseUrl : typeof item.base_url === 'string' ? item.base_url : ''
    const model = typeof item.model === 'string' && item.model ? item.model : Array.isArray(item.models) && item.models[0] ? String(item.models[0]) : ''
    if (!baseUrl || !model || !kind) return
    list.push({
      id: String(item.id || `env-provider-${index + 1}`).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 64),
      name: String(item.name || item.id || `Env provider ${index + 1}`).slice(0, 120),
      kind,
      baseUrl,
      model,
      models: Array.isArray(item.models) ? item.models.map(String).slice(0, 100) : [model],
      capabilities: normalizeCapabilities(item.capabilities).length ? normalizeCapabilities(item.capabilities) : ['chat', 'json'],
      priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : 10 + index,
      pricing: normalizePricing(item.pricing),
      routing: normalizeRouting(item.routing),
      enabled: item.enabled === undefined ? true : Boolean(item.enabled),
      source: 'env'
    })
  })
  return list
}

function storedProviders(document) {
  return document.providers.map((provider) => ({ ...provider, source: 'stored' }))
}

function mergedProviders(document) {
  const stored = storedProviders(document)
  const seen = new Set(stored.map((provider) => provider.id))
  const env = envProviders().filter((provider) => !seen.has(provider.id))
  return [...stored, ...env].sort((a, b) => (a.priority - b.priority) || a.id.localeCompare(b.id))
}

function hasApiKey(provider) {
  if (runtimeKeys.has(provider.id)) return true
  if (provider.source === 'env') {
    if (provider.id === 'default') return Boolean(process.env.AI_API_KEY) || provider.kind === 'ollama'
    const raw = process.env.NEXUS_AI_PROVIDERS_JSON
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        const list = Array.isArray(parsed) ? parsed : parsed?.providers
        const match = Array.isArray(list) ? list.find((item) => String(item?.id || '').toLowerCase() === provider.id) : null
        if (match) return Boolean(typeof match.apiKey === 'string' && match.apiKey) || provider.kind === 'ollama'
      } catch { /* fall through */ }
    }
  }
  return provider.kind === 'ollama'
}

function resolveProviderWithKey(provider) {
  let apiKey = runtimeKeys.get(provider.id) || ''
  if (!apiKey && provider.source === 'env') {
    if (provider.id === 'default') apiKey = process.env.AI_API_KEY || ''
    else {
      const raw = process.env.NEXUS_AI_PROVIDERS_JSON
      if (raw) {
        try {
          const parsed = JSON.parse(raw)
          const list = Array.isArray(parsed) ? parsed : parsed?.providers
          const match = Array.isArray(list) ? list.find((item) => String(item?.id || '').toLowerCase() === provider.id) : null
          if (match && typeof match.apiKey === 'string') apiKey = match.apiKey
          if (match && typeof match.api_key === 'string') apiKey = match.api_key
        } catch { /* leave empty */ }
      }
    }
  }
  const configured = Boolean(provider.baseUrl && provider.model && (apiKey || provider.kind === 'ollama'))
  return { ...provider, apiKey, configured, enabled: provider.enabled !== false }
}

function publicProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    host: safeHost(provider.baseUrl),
    model: provider.model,
    models: provider.models,
    contextWindow: provider.contextWindow ?? null,
    maxOutputTokens: provider.maxOutputTokens ?? null,
    temperature: provider.temperature,
    timeoutMs: provider.timeoutMs,
    priority: provider.priority,
    capabilities: provider.capabilities,
    pricing: provider.pricing,
    routing: provider.routing || {},
    enabled: provider.enabled !== false,
    source: provider.source || 'stored',
    configured: hasApiKey(provider),
    hasApiKey: hasApiKey(provider)
  }
}

function safeHost(value) {
  try { return new URL(value).host } catch { return null }
}

export function listProviderRecords({ dataDir } = {}) {
  const file = resolveStoreFile(dataDir)
  return withStoreQueue(file, async () => {
    const document = await loadStore(file)
    return jsonClone(mergedProviders(document), 'Provider list')
  })
}

export async function listPublicProviders({ dataDir } = {}) {
  const records = await listProviderRecords({ dataDir })
  return records.map(publicProvider)
}

export async function resolveProviderForInvocation({ dataDir, providerId, taskType = 'general' } = {}) {
  const records = await listProviderRecords({ dataDir })
  const id = String(providerId || '')
  let selected = null
  if (id) selected = records.find((provider) => provider.id === id) || null
  if (!selected && !providerId) {
    const routing = AGENT_TASK_TYPES.includes(taskType) ? taskType : null
    if (routing) selected = records.find((provider) => provider.enabled !== false && provider.routing?.[routing] && hasApiKey(provider)) || null
    selected = selected || records.find((provider) => provider.enabled !== false && hasApiKey(provider)) || null
  }
  if (selected) {
    if (selected.enabled === false) return null
    const resolved = resolveProviderWithKey(selected)
    return resolved.configured ? resolved : null
  }
  // Fall back to the legacy env-configured providers so runtime tasks work in
  // server deployments without a persisted provider registry.
  if (providerId && providerId !== 'default') return null
  const kind = normalizeKind(process.env.AI_PROVIDER_KIND)
  if (process.env.AI_BASE_URL && process.env.AI_MODEL && (process.env.AI_API_KEY || kind === 'ollama')) {
    return {
      id: 'default',
      name: 'Environment default',
      kind: kind || 'openai-compatible',
      baseUrl: process.env.AI_BASE_URL,
      model: process.env.AI_MODEL,
      apiKey: process.env.AI_API_KEY || '',
      configured: true,
      capabilities: ['chat', 'json'],
      priority: 0,
      pricing: {},
      routing: {},
      enabled: true,
      temperature: 0.2,
      timeoutMs: 120_000,
      maxOutputTokens: null,
      contextWindow: null,
      source: 'env'
    }
  }
  return null
}

export async function createProviderRecord({ dataDir, provider } = {}) {
  const file = resolveStoreFile(dataDir)
  return await withStoreQueue(file, async () => {
    const document = await loadStore(file)
    const normalized = normalizeProvider(provider, { requireNew: true })
    if (document.providers.length >= MAX_PROVIDERS) throw storeError('PROVIDER_STORE_LIMIT', `The provider registry is limited to ${MAX_PROVIDERS} providers.`)
    if (document.providers.some((item) => item.id === normalized.id)) throw storeError('PROVIDER_DUPLICATE_ID', `Provider id already exists: ${normalized.id}`)
    document.providers.push(jsonClone(normalized, 'Provider'))
    await writeStoreFile(file, document)
    return publicProvider({ ...normalized, source: 'stored' })
  })
}

export async function updateProviderRecord({ dataDir, providerId, patch } = {}) {
  const file = resolveStoreFile(dataDir)
  return await withStoreQueue(file, async () => {
    const document = await loadStore(file)
    const index = document.providers.findIndex((item) => item.id === providerId)
    if (index < 0) return null
    const merged = normalizeProvider({ ...document.providers[index], ...(isPlainObject(patch) ? patch : {}), id: providerId })
    document.providers[index] = jsonClone(merged, 'Provider')
    await writeStoreFile(file, document)
    return publicProvider({ ...merged, source: 'stored' })
  })
}

export async function deleteProviderRecord({ dataDir, providerId } = {}) {
  const file = resolveStoreFile(dataDir)
  return await withStoreQueue(file, async () => {
    const document = await loadStore(file)
    const index = document.providers.findIndex((item) => item.id === providerId)
    if (index < 0) return { deleted: false }
    document.providers.splice(index, 1)
    runtimeKeys.delete(String(providerId).toLowerCase())
    await writeStoreFile(file, document)
    return { deleted: true }
  })
}

export async function testProviderRecord({ dataDir, providerId, prompt = 'Reply with the single word: pong', timeoutMs = 25_000 } = {}) {
  const started = Date.now()
  try {
    const resolved = await resolveProviderForInvocation({ dataDir, providerId })
    if (!resolved) throw storeError('PROVIDER_NOT_CONFIGURED', 'Provider is not configured with an API key and model.')
    const result = await invokeAIProvider({
      providerOverride: resolved,
      messages: [{ role: 'user', content: String(prompt).slice(0, 200) }],
      temperature: 0,
      maxTokens: 512,
      timeoutMs: Math.min(60_000, Math.max(1_000, Number(timeoutMs) || 25_000)),
      maxRetries: 0
    })
    return {
      ok: true,
      latencyMs: Date.now() - started,
      providerId: resolved.id,
      model: resolved.model,
      replyPreview: redactSecrets(String(result.text || '')).slice(0, 200),
      usage: result.usage
    }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      providerId: String(providerId || ''),
      error: safeMessage(error),
      code: error?.code || null
    }
  }
}
