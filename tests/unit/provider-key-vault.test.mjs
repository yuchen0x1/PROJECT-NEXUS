import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createProviderKeyVault } from '../../desktop/provider-key-vault.mjs'
import { clearRuntimeProviderKeys, createProviderRecord, deleteProviderRecord, listProviderRecords, listPublicProviders, providerCredentialBinding, resolveProviderForInvocation, setRuntimeProviderKeys, updateProviderRecord } from '../../server/services/provider-store.mjs'
import { invokeAIProvider } from '../../server/services/ai-provider.mjs'
import { listDraftProviderModels } from '../../server/services/provider-models.mjs'
import { cleanupTestEnvironment, startHttpServer, startNexusServer, tempDataDir } from './helpers/server-harness.mjs'

// Synthetic reversible encoding only; real OS encryption is exercised by the
// desktop contract test. Never load a real user vault or environment token.
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`fixture:${value}`).reverse(),
  decryptString: (value) => {
    const decoded = Buffer.from(value).reverse().toString()
    if (!decoded.startsWith('fixture:')) throw new Error('undecryptable fixture')
    return decoded.slice(8)
  }
}
let dataDir, file, vault, snapshots, syncFailure
let originalEnv
beforeEach(async () => {
  originalEnv = { ...process.env }
  for (const key of ['AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY', 'NEXUS_AI_PROVIDERS_JSON']) delete process.env[key]
  dataDir = await tempDataDir('nexus-key-lifecycle-')
  file = path.join(dataDir, 'provider-keys.json')
  snapshots = []
  syncFailure = false
  vault = makeVault()
})
afterEach(async () => {
  clearRuntimeProviderKeys()
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  await cleanupTestEnvironment()
})
function makeVault(extra = {}) {
  return createProviderKeyVault({
    file, safeStorage,
    listProviders: () => listProviderRecords({ dataDir }),
    syncKeys: async (keys) => {
      snapshots.push(keys)
      if (syncFailure) return { synced: false }
      await setRuntimeProviderKeys(keys, { dataDir })
      return { synced: true }
    },
    ...extra
  })
}
async function provider(id = 'first', extra = {}) {
  return createProviderRecord({ dataDir, provider: { id, name: id, kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture-model', ...extra } })
}
const resolve = (providerId = 'first') => resolveProviderForInvocation({ dataDir, providerId })
const flags = async (id = 'first') => (await listPublicProviders({ dataDir })).find((item) => item.id === id)

describe('desktop provider key lifecycle', () => {
  it('revokes one and the last key from memory, listings and stale invocation snapshots', async () => {
    let requests = 0
    const baseUrl = await startHttpServer((_req, res) => { requests++; res.end('{"choices":[{"message":{"content":"pong"}}]}') })
    await provider('first', { baseUrl })
    await provider('second', { baseUrl })
    expect(await vault.set('first', 'fixture-first')).toMatchObject({ saved: true, sync: { synced: true } })
    const stale = await resolve()
    await vault.set('second', 'fixture-second')
    // An unrelated save keeps the first lease valid.
    await invokeAIProvider({ providerOverride: stale, messages: [], maxRetries: 0 })
    expect(requests).toBe(1)
    expect(await vault.delete('first')).toMatchObject({ deleted: true, sync: { synced: true } })
    expect(await resolve()).toBeNull()
    expect(await resolve('second')).toMatchObject({ apiKey: 'fixture-second' })
    expect(await flags()).toMatchObject({ configured: false, hasApiKey: false })
    await expect(invokeAIProvider({ providerOverride: stale, messages: [], maxRetries: 2 })).rejects.toMatchObject({ code: 'AI_CREDENTIAL_REVOKED' })
    expect(requests).toBe(1)
    await vault.delete('second')
    expect(snapshots.at(-1)).toEqual({})
    expect(await resolve('second')).toBeNull()
    expect(await vault.status()).toMatchObject({ providerIds: [] })
    expect(await fs.readFile(file, 'utf8')).not.toContain('fixture-first')
  })

  it.each([{ baseUrl: 'http://127.0.0.1:2/v1' }, { baseUrl: 'http://localhost:1/v1' }, { baseUrl: 'https://127.0.0.1:1/v1' }, { baseUrl: 'http://127.0.0.1:1/other' }, { kind: 'anthropic' }, { kind: 'gemini' }, { kind: 'ollama' }])('does not move a saved key after a destination edit or edit/revert: %j', async (patch) => {
    await provider()
    await vault.set('first', 'fixture-original')
    const stale = await resolve()
    const updated = await updateProviderRecord({ dataDir, providerId: 'first', patch })
    if (patch.kind !== 'ollama') expect(updated.hasApiKey).toBe(false)
    expect((await resolve())?.apiKey || '').toBe('')
    await expect(invokeAIProvider({ providerOverride: stale, messages: [], maxRetries: 0 })).rejects.toMatchObject({ code: 'AI_CREDENTIAL_REVOKED' })
    // Restart-style sync and draft discovery must not rebind the old ciphertext.
    await makeVault().sync()
    const records = await listProviderRecords({ dataDir })
    expect(await vault.getKey(records[0])).toBe('')
    if (patch.kind !== 'ollama') {
      expect((await listDraftProviderModels({ kind: updated.kind, baseUrl: updated.baseUrl, providerId: 'first' }, { records, getSavedKey: (record) => vault.getKey(record) })).errorCode).toBe('key-required')
    }
    await updateProviderRecord({ dataDir, providerId: 'first', patch: { baseUrl: 'http://127.0.0.1:1/v1', kind: 'openai-compatible' } })
    await vault.sync()
    expect(await resolve()).toBeNull()
    await provider('second')
    await vault.set('second', 'fixture-other')
    expect(await resolve()).toBeNull()
    // Explicit re-entry is the only way to authorize the new configuration.
    await vault.set('first', 'fixture-reentered')
    expect(await resolve()).toMatchObject({ apiKey: 'fixture-reentered' })
  })

  it('keeps credentials across model/name edits, normalized URLs and restart sync', async () => {
    await provider()
    await vault.set('first', 'fixture-stable')
    const before = await listProviderRecords({ dataDir })
    await updateProviderRecord({ dataDir, providerId: 'first', patch: { model: 'another-model', name: 'Renamed', baseUrl: 'http://127.0.0.1:1/v1/', credentialRevision: 'renderer-cannot-override' } })
    expect(providerCredentialBinding((await listProviderRecords({ dataDir }))[0])).toBe(providerCredentialBinding(before[0]))
    clearRuntimeProviderKeys()
    await makeVault().sync()
    expect(await resolve()).toMatchObject({ apiKey: 'fixture-stable', model: 'another-model' })
  })

  it('does not resurrect ciphertext on delete/recreate of the same provider id', async () => {
    await provider()
    await vault.set('first', 'fixture-original')
    const snapshot = snapshots.at(-1)
    await deleteProviderRecord({ dataDir, providerId: 'first' })
    await provider()
    await vault.sync()
    expect(await resolve()).toBeNull()
    await setRuntimeProviderKeys(snapshot, { dataDir })
    expect(await resolve()).toBeNull()
  })

  it('synchronizes an empty startup vault and drops undecryptable entries', async () => {
    await provider()
    await setRuntimeProviderKeys({ first: 'fixture-stale' }, { dataDir })
    await vault.sync()
    expect(await resolve()).toBeNull()
    await vault.set('first', 'fixture-saved')
    const document = JSON.parse(await fs.readFile(file, 'utf8'))
    document.keys.first.encrypted = 'not decryptable'
    await fs.writeFile(file, JSON.stringify(document))
    await makeVault().sync()
    expect(await resolve()).toBeNull()
    expect(snapshots.at(-1)).toEqual({})
  })

  it('persists only an opaque, environment-sensitive canonical binding', async () => {
    process.env.NEXUS_AI_PROVIDERS_JSON = JSON.stringify([{ id: 'env-provider', kind: 'openai-compatible', baseUrl: 'https://gateway.example.test/private/path?token=fixture-inline-url-secret', model: 'fixture-model', apiKey: 'fixture-env-key' }])
    const record = (await listProviderRecords({ dataDir })).find((item) => item.id === 'env-provider')
    expect(record).toBeDefined()
    const binding = providerCredentialBinding(record)
    expect(binding).toMatch(/^sha256:v1:[a-f0-9]{64}$/)
    expect(binding).not.toContain('gateway.example.test')
    expect(binding).not.toContain('fixture-inline-url-secret')
    const envVault = makeVault({ listProviders: () => listProviderRecords({ dataDir }) })
    await envVault.set('env-provider', 'fixture-explicit-key')
    const disk = await fs.readFile(file, 'utf8')
    expect(disk).not.toContain('gateway.example.test')
    expect(disk).not.toContain('fixture-inline-url-secret')
    expect(JSON.parse(disk).keys['env-provider'].binding).toBe(binding)
    process.env.NEXUS_AI_PROVIDERS_JSON = JSON.stringify([{ id: 'env-provider', kind: 'openai-compatible', baseUrl: 'https://gateway.example.test/private/path?token=fixture-changed-url-secret', model: 'fixture-model', apiKey: 'fixture-env-key' }])
    await envVault.sync()
    expect(snapshots.at(-1)).toEqual({})
    expect(disk).not.toContain('fixture-explicit-key')
  })

  it('rejects persisted provider URLs containing inline credentials or query secrets', async () => {
    for (const [index, baseUrl] of ['https://fixture-user@gateway.example.test/v1', 'https://gateway.example.test/v1?token=fixture-url-secret', 'https://gateway.example.test/v1#fixture-fragment'].entries()) {
      await expect(provider(`unsafe-${index}`, { baseUrl })).rejects.toMatchObject({ code: 'PROVIDER_BASE_URL_INVALID' })
    }
    await expect(fs.readFile(path.join(dataDir, 'ai-providers.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves legacy unbound ciphertext without guessing its destination', async () => {
    await provider()
    const encrypted = safeStorage.encryptString('fixture-legacy').toString('latin1')
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, keys: { first: encrypted } }))
    await vault.sync()
    expect(await resolve()).toBeNull()
    expect(await vault.status()).toMatchObject({ providerIds: [] })
    await provider('second')
    await vault.set('second', 'fixture-new')
    expect(JSON.parse(await fs.readFile(file, 'utf8')).keys.first).toBe(encrypted)
    expect(await resolve()).toBeNull()
    await vault.set('first', 'fixture-reentered')
    expect(await resolve()).toMatchObject({ apiKey: 'fixture-reentered' })
  })

  it('serializes delayed startup sync, concurrent saves and deletion without replaying stale snapshots', async () => {
    await provider()
    await provider('second')
    await vault.set('first', 'fixture-first')
    let release, started
    const ready = new Promise((resolve) => { started = resolve })
    const wait = new Promise((resolve) => { release = resolve })
    const ordered = []
    let block = true
    const queuedVault = makeVault({ syncKeys: async (keys) => {
      if (block) { block = false; started(); await wait }
      ordered.push(Object.keys(keys))
      await setRuntimeProviderKeys(keys, { dataDir })
      return { synced: true }
    } })
    const startup = queuedVault.sync()
    await ready
    const save = queuedVault.set('second', 'fixture-second')
    const deletion = queuedVault.delete('first')
    release()
    await Promise.all([startup, save, deletion])
    expect(ordered).toEqual([['first'], ['first', 'second'], ['second']])
    expect(await resolve()).toBeNull()
    expect(await resolve('second')).toMatchObject({ apiKey: 'fixture-second' })
    expect(Object.keys(JSON.parse(await fs.readFile(file, 'utf8')).keys)).toEqual(['second'])
  })

  it.each(['writeFile', 'rename'])('keeps an active credential when vault %s fails; deletion retry revokes it', async (operation) => {
    await provider()
    await vault.set('first', 'fixture-durable-key')
    let failNext = true
    const originalWrite = fs.writeFile.bind(fs)
    const originalRename = fs.rename.bind(fs)
    const fileOperations = {
      writeFile: async (...args) => {
        if (operation === 'writeFile' && failNext && String(args[0]).endsWith('.tmp')) {
          failNext = false
          throw Object.assign(new Error('fixture disk write failed'), { code: 'EIO' })
        }
        return originalWrite(...args)
      },
      rename: async (...args) => {
        if (operation === 'rename' && failNext && args[1] === file) {
          failNext = false
          throw Object.assign(new Error('fixture disk rename failed'), { code: 'EIO' })
        }
        return originalRename(...args)
      }
    }
    const retryVault = makeVault({ fileOperations })
    await expect(retryVault.delete('first')).rejects.toMatchObject({ code: 'EIO' })
    expect(await resolve()).toMatchObject({ apiKey: 'fixture-durable-key' })
    expect(JSON.parse(await fs.readFile(file, 'utf8')).keys.first).toBeDefined()
    await expect(retryVault.delete('first')).resolves.toMatchObject({ deleted: true, sync: { synced: true } })
    expect(await resolve()).toBeNull()
    expect(JSON.parse(await fs.readFile(file, 'utf8')).keys).toEqual({})
  })

  it('never reports deletion success when service revocation is unconfirmed; a retry revokes it', async () => {
    await provider()
    await vault.set('first', 'fixture-saved')
    syncFailure = true
    await expect(vault.delete('first')).rejects.toThrow(/revocation is not confirmed/)
    expect(JSON.parse(await fs.readFile(file, 'utf8')).keys).toEqual({})
    syncFailure = false
    await vault.delete('first')
    expect(await resolve()).toBeNull()
  })

  it('preserves corrupt vaults and rejects invalid/unknown saves before writing', async () => {
    await provider()
    await expect(vault.set('first', 'fixture\nheader')).rejects.toThrow(/without newlines/)
    await expect(vault.set('missing', 'fixture-key')).rejects.toThrow(/not found/)
    await fs.writeFile(file, '{corrupt')
    await expect(vault.delete('first')).rejects.toThrow()
    expect(await fs.readFile(file, 'utf8')).toBe('{corrupt')
  })

  it('validates runtime snapshots atomically and scopes keys to their data directory', async () => {
    await provider()
    await vault.set('first', 'fixture-saved')
    for (const keys of [[], { first: 'fixture-new', missing: 'fixture-unknown' }, { first: 'fixture\ninvalid' }]) {
      await expect(setRuntimeProviderKeys(keys, { dataDir })).rejects.toThrow()
      expect(await resolve()).toMatchObject({ apiKey: 'fixture-saved' })
    }
    const other = await tempDataDir()
    await fs.copyFile(path.join(dataDir, 'ai-providers.json'), path.join(other, 'ai-providers.json'))
    expect(await resolveProviderForInvocation({ dataDir: other, providerId: 'first' })).toBeNull()
    await setRuntimeProviderKeys({}, { dataDir: other })
    expect(await resolve()).toMatchObject({ apiKey: 'fixture-saved' })
  })

  it('preserves environment credentials without letting a stored override inherit them', async () => {
    process.env.AI_BASE_URL = 'http://127.0.0.1:1/v1'
    process.env.AI_MODEL = 'fixture-env-model'
    process.env.AI_API_KEY = 'fixture-env-key'
    await vault.sync()
    expect(await resolve('default')).toMatchObject({ apiKey: 'fixture-env-key', source: 'env' })
    await provider('default', { baseUrl: 'http://127.0.0.1:2/v1' })
    expect(await resolve('default')).toBeNull()
    expect(await flags('default')).toMatchObject({ configured: false, hasApiKey: false, source: 'stored' })
  })

  it('checks revocation again before retrying an already resolved inference request', async () => {
    let requests = 0
    const baseUrl = await startHttpServer(async (_req, res) => {
      requests++
      await vault.delete('first')
      res.writeHead(503)
      res.end('{"error":{"message":"temporary fixture failure"}}')
    })
    await provider('first', { baseUrl })
    await vault.set('first', 'fixture-retry')
    await expect(invokeAIProvider({ providerOverride: await resolve(), messages: [], maxRetries: 2 })).rejects.toMatchObject({ code: 'AI_CREDENTIAL_REVOKED' })
    expect(requests).toBe(1)
  })

  it('uses authoritative snapshots through the authenticated loopback API', async () => {
    const token = 'fixture-local-api-token'
    const { base } = await startNexusServer({ dataDir, stateFile: path.join(dataDir, 'state.json'), providerUrl: '', token, extraEnv: { AI_BASE_URL: '', AI_MODEL: '', AI_API_KEY: '', NEXUS_AI_PROVIDERS_JSON: '', GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_APP_ID: '', GITHUB_APP_PRIVATE_KEY: '' } })
    async function api(endpoint, method = 'GET', body) {
      const response = await fetch(`${base}/api/local-agent/${endpoint}`, { method, headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      expect(response.ok).toBe(true)
      return response.json()
    }
    await api('providers', 'POST', { id: 'first', name: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', model: 'fixture' })
    await api('provider-keys', 'POST', { keys: { first: 'fixture-loopback-key' } })
    expect((await api('providers')).providers[0]).toMatchObject({ configured: true, hasApiKey: true })
    const update = await api('providers/first', 'PATCH', { baseUrl: 'http://127.0.0.1:2' })
    expect(update.provider).toMatchObject({ configured: false, hasApiKey: false })
    await api('provider-keys', 'POST', { keys: { first: 'fixture-new-key' } })
    await api('provider-keys', 'POST', { keys: {} })
    const publicState = await api('providers')
    expect(publicState.providers[0]).toMatchObject({ configured: false, hasApiKey: false })
    expect(JSON.stringify(publicState)).not.toContain('fixture-loopback-key')
    expect((await api('providers/first/test', 'POST', {})).code).toBe('PROVIDER_NOT_CONFIGURED')
  })
})
